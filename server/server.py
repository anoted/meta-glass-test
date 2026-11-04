#!/usr/bin/env python3
"""Meta Ray-Ban Display sensor suite: ingest, record, visualize.

Sources (WebSocket /ws/ingest?key=K&src=NAME):
  web  - the glasses Web App (docs/index.html) running on Meta Ray-Ban Display
  dat  - the Android companion app (android/) using the Meta Wearables DAT SDK
  sim  - tools/sim_device.py

Viewers (WebSocket /ws/view?key=K): the dashboard (docs/dashboard.html), served here at
http://localhost:8765/ and on GitHub Pages.

Expose it to the glasses with Tailscale Funnel:  tailscale funnel --bg 8765
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import io
import json
import logging
import os
import secrets
import shutil
import struct
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import warnings

from aiohttp import WSMsgType, web

warnings.filterwarnings("ignore", message=".*web.AppKey.*")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recorder  # noqa: E402
from recorder import KIND_HEVC, KIND_JPEG, KIND_PCM16, KIND_TPUT, Session, finalize, now_ms  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
REC_ROOT = ROOT / "recordings"
KEY_FILE = Path(__file__).resolve().parent / ".secret_key"
HDR = struct.Struct(">BdH")  # kind, ts_ms (float64), meta_len
log = logging.getLogger("server")

GITHUB_PAGES_URL = os.environ.get("MGT_PAGES_URL", "https://anoted.github.io/meta-glass-test/")


def load_key() -> str:
    env = os.environ.get("MGT_KEY")
    if env:
        return env
    if KEY_FILE.exists():
        return KEY_FILE.read_text().strip()
    k = secrets.token_urlsafe(9).replace("-", "x").replace("_", "y")
    KEY_FILE.write_text(k)
    os.chmod(KEY_FILE, 0o600)
    return k


def tailscale_host() -> str | None:
    ts = shutil.which("tailscale")
    if not ts:
        return None
    try:
        out = subprocess.run([ts, "status", "--self", "--json"], capture_output=True, text=True, timeout=5)
        d = json.loads(out.stdout)
        return d["Self"]["DNSName"].rstrip(".") or None
    except Exception:  # noqa: BLE001
        return None


def pack(kind: int, ts: float, meta: dict, payload: bytes) -> bytes:
    m = json.dumps(meta, separators=(",", ":")).encode()
    return HDR.pack(kind, ts, len(m)) + m + payload


def unpack(buf: bytes):
    kind, ts, mlen = HDR.unpack_from(buf, 0)
    o = HDR.size
    meta = json.loads(buf[o : o + mlen] or b"{}")
    return kind, ts, meta, buf[o + mlen :]


# ======================================================================= preview
class HevcPreview:
    """Decodes the DAT HEVC elementary stream with ffmpeg and emits JPEG previews."""

    def __init__(self, hub: "Hub", src: str):
        self.hub, self.src = hub, src
        self.proc: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task | None = None
        self.config: list[bytes] = []
        self.last_emit = 0.0
        self.ffmpeg = shutil.which("ffmpeg")

    async def _start(self):
        if not self.ffmpeg:
            return
        self.proc = await asyncio.create_subprocess_exec(
            self.ffmpeg, "-loglevel", "error",
            "-threads", "1", "-probesize", "4096", "-analyzeduration", "0", "-f", "hevc", "-i", "pipe:0", "-vf", "scale=480:-2:out_range=full,format=yuvj420p", "-f", "image2pipe",
            "-c:v", "mjpeg", "-q:v", "5", "-threads", "1", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        self.reader = asyncio.create_task(self._read(self.proc))
        for c in self.config:
            self.proc.stdin.write(c)

    async def feed(self, payload: bytes, is_config: bool):
        if is_config:
            self.config = (self.config + [payload])[-4:]
        if self.proc is None or self.proc.returncode is not None:
            if not self.config and not is_config:
                return
            await self._start()
            if self.proc is None:
                return
            if is_config:
                return  # already written as part of config replay
        try:
            if self.proc.stdin.transport.get_write_buffer_size() > 4 << 20:
                return  # decoder is behind; skip (recording is unaffected)
            self.proc.stdin.write(payload)
        except (BrokenPipeError, ConnectionResetError, AttributeError):
            self.proc = None

    async def _read(self, proc):
        buf = b""
        try:
            while True:
                chunk = await proc.stdout.read(1 << 16)
                if not chunk:
                    break
                buf += chunk
                while True:
                    s = buf.find(b"\xff\xd8")
                    e = buf.find(b"\xff\xd9", s + 2)
                    if s < 0 or e < 0:
                        break
                    frame, buf = buf[s : e + 2], buf[e + 2 :]
                    t = time.monotonic()
                    if t - self.last_emit >= 1 / 15:
                        self.last_emit = t
                        await self.hub.to_viewers(pack(KIND_JPEG, now_ms(), {"src": self.src, "preview": "hevc"}, frame))
        except asyncio.CancelledError:
            pass

    async def close(self):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin.close()
                self.proc.kill()
            except Exception:  # noqa: BLE001
                pass
        if self.reader:
            self.reader.cancel()


# =========================================================================== hub
class Source:
    def __init__(self, ws: web.WebSocketResponse, src: str, peer: str):
        self.ws, self.src, self.peer = ws, src, peer
        self.connected = now_ms()
        self.hello: dict | None = None
        self.msgs = 0
        self.bytes = 0
        self.items: dict[str, int] = {}
        self.last_rate: dict[str, float] = {}
        self.bytes_rate = 0.0
        self._prev_items: dict[str, int] = {}
        self._prev_bytes = 0
        self.sync: dict | None = None
        self.tput: dict | None = None
        self.preview: HevcPreview | None = None


class Hub:
    def __init__(self, key: str, rec_root: Path, auto_record: bool = True, idle_close_s: float = 120):
        self.key = key
        self.rec_root = rec_root
        self.sources: dict[int, Source] = {}
        self.viewers: dict[web.WebSocketResponse, int] = {}
        self.session: Session | None = None
        self.recording = auto_record
        self.idle_close_s = idle_close_s
        self.last_source_seen = now_ms()
        self.latest: dict[str, dict] = {}  # src -> {hello, caps, tests:[...], dat_state}
        self.logs: list[dict] = []
        self.finalizing: set[str] = set()
        rec_root.mkdir(parents=True, exist_ok=True)

    # --------------------------------------------------------------- session
    def ensure_session(self) -> Session | None:
        if not self.recording:
            return None
        if self.session is None:
            self.session = Session(self.rec_root)
            log.info("recording session %s", self.session.name)
            for s in self.sources.values():
                if s.hello:
                    self.session.write_event(s.src, s.hello, now_ms())
        return self.session

    async def close_session(self):
        s, self.session = self.session, None
        if s is None:
            return
        s.close()
        log.info("closed session %s; finalizing", s.name)
        self.finalizing.add(s.name)
        await self.to_viewers_json({"t": "session_closed", "name": s.name})
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, finalize, s.dir)
        finally:
            self.finalizing.discard(s.name)
        await self.to_viewers_json({"t": "session_finalized", "name": s.name})

    # ------------------------------------------------------------- viewers
    async def to_viewers(self, data: bytes | str):
        dead = []
        for v in list(self.viewers):
            if v.closed:
                dead.append(v)
                continue
            # crude backpressure: drop frames for slow viewers
            try:
                buf = v._writer.transport.get_write_buffer_size() if v._writer and v._writer.transport else 0  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                buf = 0
            if buf > 8 << 20 and isinstance(data, bytes):
                continue
            try:
                if isinstance(data, bytes):
                    await v.send_bytes(data)
                else:
                    await v.send_str(data)
            except Exception:  # noqa: BLE001
                dead.append(v)
        for v in dead:
            self.viewers.pop(v, None)

    async def to_viewers_json(self, obj: dict):
        await self.to_viewers(json.dumps(obj, separators=(",", ":")))

    async def to_sources(self, obj: dict, target: str = "all"):
        txt = json.dumps(obj, separators=(",", ":"))
        for s in list(self.sources.values()):
            if target in ("all", s.src) and not s.ws.closed:
                try:
                    await s.ws.send_str(txt)
                except Exception:  # noqa: BLE001
                    pass

    def status(self) -> dict:
        ses = self.session
        return {
            "t": "stats",
            "now": now_ms(),
            "recording": self.recording,
            "session": ses.summary() if ses else None,
            "finalizing": sorted(self.finalizing),
            "viewers": len(self.viewers),
            "sources": [
                {
                    "src": s.src,
                    "peer": s.peer,
                    "connected_ms": s.connected,
                    "msgs": s.msgs,
                    "bytes": s.bytes,
                    "bytes_rate": round(s.bytes_rate, 1),
                    "rates": s.last_rate,
                    "items": s.items,
                    "sync": s.sync,
                    "app": (s.hello or {}).get("app"),
                    "ver": (s.hello or {}).get("ver"),
                }
                for s in self.sources.values()
            ],
        }

    async def tick(self):
        while True:
            await asyncio.sleep(1.0)
            for s in self.sources.values():
                s.last_rate = {k: v - s._prev_items.get(k, 0) for k, v in s.items.items()}
                s._prev_items = dict(s.items)
                s.bytes_rate = s.bytes - s._prev_bytes
                s._prev_bytes = s.bytes
            if self.session:
                self.session.flush()
                if not self.sources and now_ms() - self.last_source_seen > self.idle_close_s * 1000:
                    await self.close_session()
            await self.to_viewers_json(self.status())

    def add_log(self, entry: dict):
        self.logs = (self.logs + [entry])[-300:]


# ====================================================================== handlers
def is_local(request: web.Request) -> bool:
    if request.headers.get("X-Forwarded-For") or request.headers.get("Tailscale-Funnel-Request"):
        return False
    return request.remote in ("127.0.0.1", "::1")


def authed(request: web.Request) -> bool:
    k = request.query.get("key", "") or request.headers.get("X-Key", "")
    return hmac.compare_digest(k, request.app["hub"].key)


async def ws_ingest(request: web.Request):
    hub: Hub = request.app["hub"]
    if not authed(request):
        raise web.HTTPForbidden(text="bad key")
    src = recorder.safe(request.query.get("src", "web"))
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=32 << 20, compress=False)
    await ws.prepare(request)
    peer = request.headers.get("X-Forwarded-For", request.remote or "?")
    s = Source(ws, src, peer)
    hub.sources[id(ws)] = s
    hub.last_source_seen = now_ms()
    log.info("source %s connected from %s", src, peer)
    await hub.to_viewers_json({"t": "source_up", "src": src, "peer": peer})
    tput_count = {"n": 0, "bytes": 0, "t0": 0.0, "id": None, "want": 0}
    try:
        async for msg in ws:
            rx = now_ms()
            if msg.type == WSMsgType.TEXT:
                s.msgs += 1
                s.bytes += len(msg.data)
                try:
                    obj = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                t = obj.get("t")
                if t == "ping":
                    await ws.send_str(json.dumps({"t": "pong", "id": obj.get("id"), "t0": obj.get("t0"), "ts": now_ms()}))
                    continue
                if t == "tput_begin":
                    tput_count.update(n=0, bytes=0, t0=rx, id=obj.get("id"), want=int(obj.get("n", 0)))
                    continue
                if t == "tput_down":
                    n, size = min(int(obj.get("n", 16)), 256), min(int(obj.get("size", 65536)), 1 << 20)
                    blob = pack(KIND_TPUT, now_ms(), {"id": obj.get("id")}, os.urandom(size))
                    await ws.send_str(json.dumps({"t": "tput_down_begin", "id": obj.get("id"), "n": n, "size": size}))
                    for _ in range(n):
                        await ws.send_bytes(blob)
                    await ws.send_str(json.dumps({"t": "tput_down_end", "id": obj.get("id")}))
                    continue
                if t == "hello":
                    s.hello = obj
                    hub.latest.setdefault(src, {})["hello"] = obj
                    await ws.send_str(json.dumps({"t": "welcome", "ts": now_ms(), "recording": hub.recording,
                                                  "session": hub.session.name if hub.session else None}))
                elif t == "batch":
                    for it in obj.get("items") or []:
                        k = it.get("s", "?")
                        s.items[k] = s.items.get(k, 0) + 1
                elif t == "sync":
                    s.sync = {"rtt": obj.get("rtt"), "offset": obj.get("offset")}
                elif t == "caps":
                    hub.latest.setdefault(src, {})["caps"] = obj
                elif t in ("test", "test_suite", "nb_test"):
                    lst = hub.latest.setdefault(src, {}).setdefault("tests", [])
                    lst.append(obj)
                    del lst[:-200]
                elif t == "dat_state":
                    hub.latest.setdefault(src, {})["dat_state"] = obj
                elif t == "relay":
                    # source -> other source, e.g. phone tests showing prompts on the glasses display
                    target = str(obj.get("target", "web"))
                    if target != src:
                        await hub.to_sources({"t": "cmd", "cmd": obj.get("cmd"), "args": obj.get("args") or {}}, target)
                elif t == "log":
                    hub.add_log({"src": src, "rx": rx, **obj})
                ses = hub.ensure_session()
                if ses:
                    ses.write_event(src, obj, rx)
                obj["_src"] = src
                obj["_rx"] = rx
                await hub.to_viewers(json.dumps(obj, separators=(",", ":")))
            elif msg.type == WSMsgType.BINARY:
                data = msg.data
                s.bytes += len(data)
                try:
                    kind, ts, meta, payload = unpack(data)
                except Exception:  # noqa: BLE001
                    continue
                if kind == KIND_TPUT:
                    if tput_count["n"] == 0:
                        tput_count["t0"] = rx
                    tput_count["n"] += 1
                    tput_count["bytes"] += len(data)
                    if tput_count["n"] >= tput_count["want"] > 0:
                        ms = max(rx - tput_count["t0"], 0.001)
                        await ws.send_str(json.dumps({"t": "tput_result", "id": tput_count["id"], "bytes": tput_count["bytes"],
                                                      "ms": ms, "mbps": tput_count["bytes"] * 8 / ms / 1000}))
                        tput_count["want"] = 0
                    continue
                key = {1: "video_chunk", 2: "audio_chunk", 3: "jpeg", 4: "photo", 5: "webm"}.get(kind, f"bin{kind}")
                s.items[key] = s.items.get(key, 0) + 1
                ses = hub.ensure_session()
                if ses:
                    ses.write_binary(src, kind, ts, meta, payload, rx)
                meta = dict(meta, src=src)
                if kind == KIND_HEVC:
                    if s.preview is None:
                        s.preview = HevcPreview(hub, src)
                    await s.preview.feed(payload, bool(meta.get("cfg")))
                elif kind in (KIND_JPEG, KIND_PCM16, recorder.KIND_PHOTO) and hub.viewers:
                    if kind == recorder.KIND_PHOTO and meta.get("ext") not in ("jpg", "jpeg", "png", "webp"):
                        continue
                    await hub.to_viewers(pack(kind, ts, meta, payload))
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        hub.sources.pop(id(ws), None)
        hub.last_source_seen = now_ms()
        if s.preview:
            await s.preview.close()
        if hub.session:
            hub.session.write_event(src, {"t": "source_down", "msgs": s.msgs, "bytes": s.bytes}, now_ms())
        log.info("source %s disconnected (%d msgs)", src, s.msgs)
        await hub.to_viewers_json({"t": "source_down", "src": src})
    return ws


async def ws_view(request: web.Request):
    hub: Hub = request.app["hub"]
    if not authed(request):
        raise web.HTTPForbidden(text="bad key")
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4 << 20)
    await ws.prepare(request)
    hub.viewers[ws] = 1
    await ws.send_str(json.dumps({"t": "view_hello", "latest": hub.latest, "logs": hub.logs[-100:], "status": hub.status()}, default=str))
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                obj = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            t = obj.get("t")
            if t == "cmd":
                # forwarded to sources: {t:"cmd", target:"web"|"dat"|"all", cmd:"...", args:{}}
                await hub.to_sources({"t": "cmd", "cmd": obj.get("cmd"), "args": obj.get("args") or {}}, obj.get("target", "all"))
                if hub.session:
                    hub.session.write_event("viewer", obj, now_ms())
            elif t == "srv":
                op = obj.get("op")
                if op == "marker":
                    m = {"t": "marker", "label": str(obj.get("label", ""))[:200], "ts": now_ms()}
                    ses = hub.ensure_session()
                    if ses:
                        ses.write_event("viewer", m, now_ms())
                    await hub.to_sources({"t": "cmd", "cmd": "marker", "args": {"label": m["label"]}})
                    await hub.to_viewers_json(dict(m, _src="viewer"))
                elif op == "new_session":
                    await hub.close_session()
                    hub.recording = True
                    hub.ensure_session()
                elif op == "stop_rec":
                    hub.recording = False
                    await hub.close_session()
                elif op == "start_rec":
                    hub.recording = True
                    if hub.sources:
                        hub.ensure_session()
                await hub.to_viewers_json(hub.status())
    finally:
        hub.viewers.pop(ws, None)
    return ws


# ------------------------------------------------------------------------- REST
def links(request: web.Request) -> dict:
    hub: Hub = request.app["hub"]
    host = request.app["public_host"]
    pages = GITHUB_PAGES_URL
    glasses_url = f"{pages}?server={host}&key={hub.key}" if host else None
    dash_url = f"{pages}dashboard.html?server={host}&key={hub.key}" if host else None
    deeplink = (
        "fb-viewapp://web_app_deep_link?appName=" + urllib.parse.quote("Sensor Suite")
        + "&appUrl=" + urllib.parse.quote(glasses_url, safe="")
    ) if glasses_url else None
    android_link = f"metaglasstest://config?server={urllib.parse.quote(f'wss://{host}/ws/ingest', safe='')}&key={hub.key}" if host else None
    return {
        "key": hub.key,
        "public_host": host,
        "ingest_url": f"wss://{host}/ws/ingest" if host else None,
        "pages_url": pages,
        "glasses_url": glasses_url,
        "remote_dashboard_url": dash_url,
        "glasses_deeplink": deeplink,
        "android_config_link": android_link,
    }


async def api_local(request: web.Request):
    if not is_local(request):
        raise web.HTTPForbidden(text="local only")
    return web.json_response(links(request))


async def api_links(request: web.Request):
    if not authed(request):
        raise web.HTTPForbidden()
    return web.json_response(links(request))


async def api_status(request: web.Request):
    if not authed(request):
        raise web.HTTPForbidden()
    return web.json_response(request.app["hub"].status(), dumps=lambda o: json.dumps(o, default=str))


async def api_sessions(request: web.Request):
    if not authed(request):
        raise web.HTTPForbidden()
    hub: Hub = request.app["hub"]
    out = []
    for d in sorted(hub.rec_root.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        try:
            summ = json.loads((d / "session.json").read_text())
        except Exception:  # noqa: BLE001
            summ = {}
        size = sum(p.stat().st_size for p in d.rglob("*") if p.is_file())
        files = sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file() and "_frames" not in str(p.parent))
        out.append({"name": d.name, "bytes": size, "duration_s": summ.get("duration_s"), "closed": summ.get("closed"),
                    "counts": summ.get("counts", {}), "files": files[:400], "has_report": (d / "report.html").exists(),
                    "finalizing": d.name in hub.finalizing})
    return web.json_response(out[:200])


async def api_file(request: web.Request):
    if not authed(request):
        raise web.HTTPForbidden()
    hub: Hub = request.app["hub"]
    base = (hub.rec_root / recorder.safe(request.match_info["name"])).resolve()
    p = (base / request.match_info["path"]).resolve()
    if not str(p).startswith(str(base) + os.sep) or not p.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(p)


async def api_finalize(request: web.Request):
    if not authed(request):
        raise web.HTTPForbidden()
    hub: Hub = request.app["hub"]
    d = hub.rec_root / recorder.safe(request.match_info["name"])
    if not d.is_dir() or (hub.session and hub.session.dir == d):
        raise web.HTTPBadRequest(text="unknown or active session")
    hub.finalizing.add(d.name)
    try:
        await asyncio.get_running_loop().run_in_executor(None, finalize, d)
    finally:
        hub.finalizing.discard(d.name)
    return web.json_response({"ok": True})


async def api_qr(request: web.Request):
    if not (authed(request) or is_local(request)):
        raise web.HTTPForbidden()
    import qrcode
    import qrcode.image.svg

    data = request.query.get("data", "")[:2000]
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    bio = io.BytesIO()
    img.save(bio)
    return web.Response(body=bio.getvalue(), content_type="image/svg+xml")


@web.middleware
async def cors(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response()
    else:
        resp = await handler(request)
    if request.path.startswith("/api/"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "X-Key, Content-Type"
    if request.path.endswith((".html", ".js", ".css", ".json", "/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


async def index(request: web.Request):
    raise web.HTTPFound("/dashboard.html")


def make_app(key: str, rec_root: Path = REC_ROOT, public_host: str | None = None, auto_record: bool = True, idle_close_s: float = 120) -> web.Application:
    app = web.Application(middlewares=[cors], client_max_size=64 << 20)
    hub = Hub(key, rec_root, auto_record=auto_record, idle_close_s=idle_close_s)
    app["hub"] = hub
    app["public_host"] = public_host
    app.router.add_get("/", index)
    app.router.add_get("/ws/ingest", ws_ingest)
    app.router.add_get("/ws/view", ws_view)
    app.router.add_get("/api/local", api_local)
    app.router.add_get("/api/links", api_links)
    app.router.add_get("/api/status", api_status)
    app.router.add_get("/api/sessions", api_sessions)
    app.router.add_get("/api/sessions/{name}/{path:.+}", api_file)
    app.router.add_post("/api/sessions/{name}/finalize", api_finalize)
    app.router.add_get("/api/qr.svg", api_qr)
    app.router.add_static("/", DOCS, show_index=False, append_version=False)

    async def on_start(app):
        app["ticker"] = asyncio.create_task(hub.tick())

    async def on_stop(app):
        app["ticker"].cancel()
        if hub.session:
            s, hub.session = hub.session, None
            s.close()
            await asyncio.get_running_loop().run_in_executor(None, finalize, s.dir)

    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--public-host", default=None, help="public HTTPS host (default: this machine's Tailscale name)")
    ap.add_argument("--no-auto-record", action="store_true")
    ap.add_argument("--idle-close", type=float, default=120, help="close session after N s with no sources")
    ap.add_argument("--recordings", default=str(REC_ROOT))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    key = load_key()
    host = args.public_host or tailscale_host()
    app = make_app(key, Path(args.recordings), host, not args.no_auto_record, args.idle_close)
    print("\n  Meta Ray-Ban Display sensor suite")
    print(f"  dashboard (local) : http://localhost:{args.port}/")
    if host:
        pages = GITHUB_PAGES_URL
        print(f"  public endpoint   : https://{host}/   (needs: tailscale funnel --bg {args.port})")
        print(f"  glasses web app   : {pages}?server={host}&key={key}")
        print(f"  android ingest    : wss://{host}/ws/ingest  key={key}")
    print(f"  recordings        : {args.recordings}\n")
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
