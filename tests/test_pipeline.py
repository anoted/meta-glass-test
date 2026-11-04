"""End-to-end: server + simulated web/DAT sources -> recording on disk + viewer fan-out."""
import asyncio
import csv
import json
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import pytest
import websockets
from aiohttp import web

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "server"), str(ROOT / "tools")]
import server  # noqa: E402
import sim_device  # noqa: E402

KEY = "testkey123"


@pytest.fixture
def h265(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg missing")
    p = tmp_path / "v.h265"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=24", "-t", "2",
                    "-c:v", "libx265", "-x265-params", "log-level=none", "-f", "hevc", str(p)], check=True)
    return p


async def _serve(tmp_path):
    app = server.make_app(KEY, tmp_path / "rec", public_host="example.ts.net", idle_close_s=0.5)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return app, runner, port


def test_pipeline(tmp_path, h265):
    async def main():
        app, runner, port = await _serve(tmp_path)
        url = f"ws://127.0.0.1:{port}/ws/ingest"
        got = {"json": 0, "jpeg": 0, "pcm": 0}
        async def viewer():
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws/view?key={KEY}", max_size=None) as v:
                async for m in v:
                    if isinstance(m, str):
                        got["json"] += 1
                    elif m[0] == 3:
                        got["jpeg"] += 1
                    elif m[0] == 2:
                        got["pcm"] += 1
        vt = asyncio.create_task(viewer())
        await asyncio.sleep(0.2)
        # bad key is rejected
        with pytest.raises(Exception):
            async with websockets.connect(f"{url}?src=web&key=nope"):
                pass
        await asyncio.gather(sim_device.run(url, KEY, "web", 3, None), sim_device.run(url, KEY, "dat", 3, str(h265)))
        await asyncio.sleep(3.5)  # idle close + finalize
        vt.cancel()
        await runner.cleanup()
        return got

    got = asyncio.run(main())
    sessions = list((tmp_path / "rec").iterdir())
    assert len(sessions) == 1, sessions
    d = sessions[0]
    summ = json.loads((d / "session.json").read_text())
    assert summ["closed"] and summ["counts"]["web.motion"] > 100 and summ["counts"]["dat.dat_motion"] > 200
    assert set(summ["sources"]) >= {"web", "dat"}
    rows = list(csv.DictReader(open(d / "csv" / "web.motion.csv")))
    assert len(rows) > 100 and "ax" in rows[0] and "_rx" in rows[0]
    assert (d / "csv" / "dat.dat_motion.csv").exists() and (d / "csv" / "dat.dat_input.csv").exists()
    assert (d / "media" / "dat_video.h265").stat().st_size > 1000
    assert (d / "media" / "dat_video.mp4").stat().st_size > 1000
    with wave.open(str(d / "media" / "dat_audio.wav")) as w:
        assert w.getframerate() == 16000 and w.getnframes() > 1000
    assert (d / "web_capabilities.json").exists() and (d / "web_tests.jsonl").exists()
    assert (d / "report.html").stat().st_size > 5000
    assert got["json"] > 10 and got["pcm"] >= 1 and got["jpeg"] >= 1, got


def test_local_api_and_static(tmp_path):
    async def main():
        app, runner, port = await _serve(tmp_path)
        import aiohttp
        async with aiohttp.ClientSession() as s:
            r = await s.get(f"http://127.0.0.1:{port}/api/local")
            j = await r.json()
            assert j["key"] == KEY and "fb-viewapp://web_app_deep_link" in j["glasses_deeplink"]
            r = await s.get(f"http://127.0.0.1:{port}/api/local", headers={"X-Forwarded-For": "1.2.3.4"})
            assert r.status == 403
            r = await s.get(f"http://127.0.0.1:{port}/api/sessions?key=bad")
            assert r.status == 403
            for p in ("index.html", "app.js", "dashboard.html", "dashboard.js", "charts.js", "manifest.json", "icon-192.png"):
                r = await s.get(f"http://127.0.0.1:{port}/{p}")
                assert r.status == 200, p
            r = await s.get(f"http://127.0.0.1:{port}/api/qr.svg?key={KEY}&data=hello")
            assert r.status == 200 and b"<svg" in await r.read()
            r = await s.get(f"http://127.0.0.1:{port}/api/sessions/x/..%2F..%2Fetc%2Fpasswd?key={KEY}")
            assert r.status == 404
        await runner.cleanup()
    asyncio.run(main())


def test_relay_between_sources(tmp_path):
    """Phone (dat) test prompts reach the glasses Web App (web) as commands; never echoed to the sender."""
    async def main():
        app, runner, port = await _serve(tmp_path)
        url = f"ws://127.0.0.1:{port}/ws/ingest"
        async with websockets.connect(f"{url}?src=web&key={KEY}") as web_ws, websockets.connect(f"{url}?src=dat&key={KEY}") as dat_ws:
            await web_ws.send(json.dumps({"t": "hello", "src": "web"}))
            await dat_ws.send(json.dumps({"t": "hello", "src": "dat"}))
            await asyncio.sleep(0.2)
            await dat_ws.send(json.dumps({"t": "relay", "target": "web", "cmd": "show", "args": {"text": "Nod your head"}}))
            got = None
            while got is None:
                m = json.loads(await asyncio.wait_for(web_ws.recv(), 3))
                if m.get("t") == "cmd":
                    got = m
            assert got == {"t": "cmd", "cmd": "show", "args": {"text": "Nod your head"}}
            await dat_ws.send(json.dumps({"t": "relay", "target": "dat", "cmd": "show", "args": {}}))
            with pytest.raises(asyncio.TimeoutError):
                while True:
                    m = json.loads(await asyncio.wait_for(dat_ws.recv(), 0.5))
                    if m.get("t") == "cmd":
                        break
        await runner.cleanup()
    asyncio.run(main())
