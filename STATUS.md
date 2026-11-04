# Work status (updated 2026-11-04)

## Done
- `server/` recorder + dashboard; `relay` message lets the phone show prompts on the glasses Web App.
- `docs/` glasses Web App + dashboard (GitHub Pages: https://anoted.github.io/meta-glass-test/).
- `android/` DAT companion app (`App`, `MainActivity`, `LinkService`, `GlassLink`, `Uplink`, `DatTests`);
  `JAVA_HOME=~/.jdks/jdk-21.0.13+9 ./gradlew assembleDebug` builds `app/build/outputs/apk/debug/app-debug.apk`.
- `README.md`, `run.sh` (venv + Tailscale Funnel + server), `requirements.txt`.
- Tests: `./run.sh test` → 3 passed (pipeline, local API/static, source relay).

## First hardware run (2026-11-04, recordings/2026-11-04_12-51-50 and _14-42-50)
Glasses: Meta RB Display, fw build 69951180085500080 (SDK reports COMPATIBLE). Phone: Galaxy A54, Android 16.
- DAT: registration OK, device CONNECTED/COMPATIBLE, but the glasses end every session ~230 ms after start with
  `DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED` ("Your glasses need an update…"). This is the DAT app *on the glasses*
  (installed/updated from Meta AI → App Connections, or Developer Mode → Install), not the firmware.
  → App now shows a banner + "Update DAT app on glasses" (`Wearables.openDATGlassesAppUpdate`).
- Web App: every Neural Band pinch arrived as mouse pointerdown/click at (300,300) **plus** Enter, because
  `touch-action:none` on body opted the whole page into drag mode. The pointerdown blurred the focused tile, so
  Enter hit <body>. Touchpad taps (plain Enter) worked. → drag opt-in moved to `drag.html`; pointerdown no longer
  steals focus; pointer clicks are ignored when an Enter accompanies them.
- Web geolocation: "Location permission denied on phone" → grant location to the Meta AI app on the phone.
- Web IMU fine: 60 Hz devicemotion/orientation, |g|≈9.8, perf 30 fps.

## Added after the run
- DAT: `mwdat-display` status card on the glasses during a session (switch, default on; it takes the display
  from the Web App), explicit handling of each `DeviceSessionError`, Inputs re-added after doff/don (SDK known
  issue), registration intents handled even without a data URI.
- Web: Neural Band wrist quaternion via `RelativeOrientationSensor({sensorId:"emg-wrist"})` (`nb_wrist` stream,
  `nb_wrist` test); single sensor-permission request; responsive viewport meta.

## Still to verify on hardware
- After updating the DAT glasses app: session STARTED, camera/motion/inputs/display states, accel units in `dat_imu_still`.
- Pinch now activates tiles on the glasses; wrist sensor marker `__imuQuatWrapped` present.
