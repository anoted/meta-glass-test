# Meta Ray-Ban Display + Neural Band sensor test suite

Streams every sensor and input that Meta's platforms expose from **Meta Ray-Ban Display** glasses and the
**Meta Neural Band** to a PC, where everything is visualized live and recorded.

```
 Ray-Ban Display ──(Web App, GitHub Pages)────────────┐
   head IMU · orientation · battery · location ·      │  wss:// (Tailscale Funnel)
   swipe/pinch keys · TTS · display                    ├──────────────► PC recorder + dashboard
                                                       │                server/ · localhost:8765
 Android phone ──(DAT SDK companion app, android/)────┘                recordings/<session>/
   camera video (HEVC) · mic audio · photos · speech ·
   glasses IMU · Neural Band IMU · touchpad / buttons /
   Neural Band gestures + drag · battery, thermal, worn, hinge
```

## Why two apps on the glasses side

| Data | Glasses Web App | Android DAT app |
|---|:-:|:-:|
| Head accelerometer / gyroscope / orientation | ✓ (DeviceMotion/Orientation) | ✓ (`mwdat-motion`, up to 60 Hz) |
| Neural Band IMU | – | ✓ (`MotionSource.NEURAL_BAND`) |
| Neural Band gestures | ✓ as arrow / Enter keys | ✓ with source (`NEURAL_BAND`, `NEURAL_BAND_DRAG`) |
| Touchpad, capture & action buttons | – | ✓ (`mwdat-inputs`) |
| Camera video, photos | – (blocked for Web Apps) | ✓ (`mwdat-camera`) |
| Microphone audio | – (blocked for Web Apps) | ✓ 16 kHz PCM |
| Speech recognition | – | ✓ (`mwdat-speech`) |
| Battery, thermal, worn (don), hinge, firmware | battery only | ✓ device metadata |
| Location | ✓ (from the phone) | – |
| Text-to-speech, display | ✓ | – |
| Raw Neural Band EMG | not exposed by any Meta API | not exposed |

Motion, Inputs, Speech, audio streaming and standalone photo capture are marked **experimental** in DAT 1.0.1;
they may have to be enabled for your app in the Wearables Developer Center.

## Quick start

1. **PC** (Linux, with `tailscale`, `ffmpeg`, Python ≥ 3.10):
   ```bash
   ./run.sh          # creates .venv, starts Tailscale Funnel on 443 -> localhost:8765, starts the recorder
   ```
   It prints the dashboard URL, the glasses Web App link with your key, and the Android ingest URL.
   The access key is generated once into `server/.secret_key` (or set `MGT_KEY`).
   First time only: `sudo tailscale set --operator=$USER` and enable Funnel for the node.
2. **Dashboard:** open <http://localhost:8765/>. The *Setup* tab shows the links and QR codes for the glasses and the phone.
3. **Glasses Web App:** Meta AI app → Settings → App Info → tap the version 5× (Developer Mode) → App Settings →
   Apps → Web Apps → Connect Web App, and paste `https://anoted.github.io/meta-glass-test/?server=<your-host>&key=<key>`
   (or scan the deep-link QR in the dashboard). On the glasses: *Enable sensors*, then *Run test suite*,
   *Neural Band*, *Live sensors*, *Drag pad*.
4. **Android app:** enable Developer Mode in the Meta AI app, then
   ```bash
   cd android && JAVA_HOME=~/.jdks/jdk-21.0.13+9 ./gradlew installDebug
   ```
   Scan the phone QR in the dashboard (`metaglasstest://config?...`) or type the server and key. Tap
   *Register* → *Camera / Mic permission* → *Start session* → *Run all DAT tests*. The phone keeps streaming
   with the screen off (foreground service).

Nothing is recorded until you press **Start recording** on the dashboard (or start the server with `--auto-record`). Recording stops with **Stop recording**, or on its own once every source has been gone for `--idle-close` seconds (default 120); after that it stays off until you start it again. The dashboard can also start a new session and drop markers.

## Test suites

- **Glasses Web App** (`docs/app.js`): browser API probe, motion permission, IMU at rest (rate, noise, gravity),
  compass, Generic Sensor API, location, battery, network info, RTT + clock offset, uplink and downlink
  throughput, display refresh/geometry, speaker (TTS), storage, camera/mic availability, misc APIs, Neural
  Band / touchpad keys, pinch-and-drag; plus the **Neural Band gesture test** (prompted gestures, confusion
  table, accuracy, reaction latency).
- **Android DAT app** (`android/.../DatTests.kt`): registration, device metadata, permissions, session start
  time, camera fps/bitrate/frame gaps, mic noise floor vs. speech level, photo capture, IMU noise floor and
  accel units, sampling-rate sweep 5–60 Hz per source, prompted axis discovery for head and Neural Band,
  prompted input sources (touchpad, capture/action buttons, Neural Band swipes, pinches, drag), speech word
  recall, uplink RTT and throughput. Prompts are spoken and shown on the glasses if the Web App is open.

Both suites can be started remotely from the dashboard; results appear live and in each session's report.

## Recording layout

```
recordings/<session>/
  session.json            summary: sources, per-stream counts, markers
  events.jsonl            every message, with server receive time (_rx) and source (_src)
  streams/*.jsonl, csv/*.csv   one file per source and sensor stream
  media/dat_video.h265 / .mp4, dat_video_frames.csv, dat_audio.wav, dat_photos/
  web_capabilities.json, *_tests.jsonl
  report.html             charts + test results (tools/report.py)
```

## Layout

| Path | What |
|---|---|
| `docs/` | GitHub Pages: glasses Web App (`index.html`, 600×600) and dashboard (`dashboard.html`) |
| `server/` | aiohttp ingest/recorder/viewer server |
| `android/` | Kotlin DAT SDK companion app (`io.github.anoted.mgt`) |
| `tools/` | `report.py` (session report), `sim_device.py` (simulated sources) |
| `tests/` | end-to-end tests (`./run.sh test`) |

Wire protocol (shared by all sources): JSON text frames `{t:"hello"|"batch"|"test"|...}`, sample batches
`{t:"batch", items:[{s:<stream>, ts:<epoch ms>, ...}]}`, and binary frames
`[u8 kind][f64 ts_ms BE][u16 meta_len BE][meta JSON][payload]` for video, audio and photos.
