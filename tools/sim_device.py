#!/usr/bin/env python3
"""Simulate the glasses Web App and/or the Android DAT app against the server.

    python tools/sim_device.py --url ws://localhost:8765/ws/ingest --key KEY --src web --seconds 10
    python tools/sim_device.py --url ... --src dat --video sample.h265

Used by tests/test_pipeline.py and for checking the dashboard without hardware.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import struct
import time

import websockets

HDR = struct.Struct(">BdH")


def now() -> float:
    return time.time() * 1000


def pack(kind, meta, payload) -> bytes:
    m = json.dumps(meta).encode()
    return HDR.pack(kind, now(), len(m)) + m + payload


async def run(url: str, key: str, src: str, seconds: float, video: str | None):
    async with websockets.connect(f"{url}?src={src}&key={key}", max_size=None) as ws:
        await ws.send(json.dumps({"t": "hello", "src": src, "app": f"sim-{src}", "ver": "0", "ts": now(), "info": {"ua": "simulator", "viewport": {"w": 600, "h": 600}}}))

        async def reader():
            async for m in ws:
                if isinstance(m, str):
                    o = json.loads(m)
                    if o.get("t") == "cmd":
                        await ws.send(json.dumps({"t": "log", "level": "info", "msg": f"sim got cmd {o.get('cmd')}"}))

        rt = asyncio.create_task(reader())
        t_end = time.time() + seconds
        i = 0
        tns = time.monotonic_ns()
        if src == "web":
            await ws.send(json.dumps({"t": "caps", "ts": now(), "caps": {"DeviceMotionEvent": {"ok": True, "detail": None}, "mediaDevices.getUserMedia": {"ok": False, "detail": None}}}))
        h265 = open(video, "rb").read() if video else None
        vpos = 0
        while time.time() < t_end:
            items = []
            for _ in range(6):  # 60 Hz in 100 ms batches
                i += 1
                t = now()
                ph = i / 60
                if src == "web":
                    items.append({"s": "motion", "ts": t, "ax": math.sin(ph), "ay": 9.81 + 0.1 * random.random(), "az": math.cos(ph), "lx": 0, "ly": 0, "lz": 0,
                                  "ra": 20 * math.sin(ph), "rb": 5, "rg": 0, "iv": 16.7})
                    items.append({"s": "orient", "ts": t, "a": (ph * 20) % 360, "b": 10 * math.sin(ph), "g": 5 * math.cos(ph), "abs": False})
                else:
                    tns += 16_666_667
                    for s in ("GLASSES", "NEURAL_BAND"):
                        items.append({"s": "dat_motion", "ts": t, "tns": tns, "src": s, "ax": math.sin(ph), "ay": 9.81, "az": 0.1, "gx": 0.1 * math.sin(ph), "gy": 0, "gz": 0,
                                      "mx": 30, "my": -12, "mz": 40, "qw": math.cos(ph / 4), "qx": 0, "qy": 0, "qz": math.sin(ph / 4)})
            if i % 60 == 0:
                if src == "web":
                    items.append({"s": "input", "ts": now(), "ev": "keydown", "key": random.choice(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"])})
                    items.append({"s": "geo", "ts": now(), "lat": 23.78 + i * 1e-6, "lon": 90.4, "acc": 12})
                    items.append({"s": "sync", "ts": now(), "rtt": 30, "offset": 0, "best_rtt": 28})
                else:
                    items.append({"s": "dat_input", "ts": now(), "tms": int(time.monotonic() * 1000), "type": "nav", "src": "NEURAL_BAND", "dir": "RIGHT"})
                    items.append({"s": "dat_device", "ts": now(), "name": "Sim Display", "type": "META_RAYBAN_DISPLAY", "battery": 77, "link": "CONNECTED", "don": "DONNED"})
                    pcm = struct.pack("<1600h", *[int(8000 * math.sin(2 * math.pi * 440 * k / 16000)) for k in range(1600)])
                    await ws.send(pack(2, {"pts": i * 1000, "sr": 16000, "ch": 1}, pcm))
            await ws.send(json.dumps({"t": "batch", "ts": now(), "items": items}))
            if h265 and vpos < len(h265):
                chunk = h265[vpos: vpos + 8000]
                await ws.send(pack(1, {"pts": i * 16666, "cfg": vpos == 0, "w": 360, "h": 640}, chunk))
                vpos += len(chunk)
            await asyncio.sleep(0.1)
        await ws.send(json.dumps({"t": "test", "ts": now(), "name": "sim_check", "title": "Simulator check", "status": "pass", "metrics": {"i": i}, "t_start": now() - 1000, "t_end": now()}))
        await asyncio.sleep(0.3)
        rt.cancel()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://localhost:8765/ws/ingest")
    ap.add_argument("--key", required=True)
    ap.add_argument("--src", default="web", choices=["web", "dat", "sim"])
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--video", default=None, help="raw .h265 Annex-B file to stream as DAT video")
    a = ap.parse_args()
    asyncio.run(run(a.url, a.key, a.src, a.seconds, a.video))
