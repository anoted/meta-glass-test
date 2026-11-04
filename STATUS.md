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

## Second hardware run (2026-11-04, recordings/2026-11-04_15-29-05 … _15-40-57)
- DAT session works after updating the glasses DAT app: camera 24 fps, photo, motion 5–60 Hz, latency p50 31 ms.
- DAT Inputs: only CAPTOUCH events, 0 Neural Band events on every nb_* prompt. Cause: `InputsConfiguration(emptySet())`;
  `sources` is a filter, default = CAPTOUCH, NEURAL_BAND, CAPTURE_BUTTON, ACTION_BUTTON, NEURAL_BAND_DRAG.
  → now requests all of them explicitly and logs `dat_inputs_cfg`.
- DAT Motion: only `src=GLASSES` samples (band arm moves gave no NEURAL_BAND samples). MotionConfiguration has no
  source selector; to re-check with Inputs fixed.
- Display card now has Mark / Photo buttons (`dat_display_click`) so band focus+pinch has a target; the card is
  only re-sent on state changes so focus is not reset. `dat_inputs` test: dropped the touchpad tap step (a tap
  pauses the session), added `nb_display`.
- Web App on the glasses still loads the old build from GitHub Pages (tile ids `drag`/`neural`); the pinch fix only
  takes effect after a push.

- 15:56–16:09: every session start failed. The SDK's log line shows `START_ERROR_DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED`
  (20/20), but apps only get SESSION_ENDED_BY_DEVICE. The glasses DAT app seems to reset after re-registering. The app
  now reads its own log for the real code (`dat_error cap=session.start`) and shows the update banner.

## Third run (recordings/2026-11-04_16-13-03, 16-00-49, 16-03-42)
- DAT Inputs with all sources: NEURAL_BAND nav U/D/L/R + select, and NEURAL_BAND_DRAG (29 drags, 447 MOVE samples).
  Drag = pinch-and-hold then move the hand: DOWN at (0,0), MOVE ~30 Hz with x,y = displacement from the pinch point
  (seen about ±0.18 units), dx,dy = per-sample delta, UP on release. A pinch-joystick driven by the band, not a touch.
- DAT Motion: 11,588 samples, all GLASSES. The band's IMU is not delivered to DAT on this firmware.
- Web: `emg-wrist` quaternion works, ~32 Hz (p50 dt 30 ms), nb_wrist test pass (98 deg twist span). No raw band
  gyro/accel in either API; app.js now derives wrist angular velocity (wx,wy,wz deg/s) and stores quaternions at 5 dp.

## Glasses DAT app updates (phone logcat, 16:13–16:24)
- The glasses-side app is "DevMode DWA" (`com.meta.wearable.dat.developer`, versionCode 1073534694, 4.7 MB). Meta AI
  (v297) installs it over Wi-Fi Direct (AppHub logs). 16:13 install succeeded and the session started.
- `Wearables.openDATGlassesAppUpdate` sends `fb-viewapp://stella/dat?action=update_dat_app…`. Meta AI only installs when
  it thinks the glasses are behind; the server version equalled the installed one, so later taps bounced to its home
  tab (16:23:54–16:24:08), and with Meta AI already on a settings page nothing happened (16:22). Yet the glasses kept
  answering START_ERROR_DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED.
- The glasses never disconnected between the working 16:13 session and the 16:22 failure. Each failure streak began
  after the phone app process restarted (15:50 reinstall, 16:22 relaunch). Unconfirmed; to test, force-stop and
  reopen the app right after a working session.
- The update button now opens a dialog: try the SDK link, or "Open Meta AI" (fresh task) and use
  App connections → Developer mode apps → Install.

Neural Band inputs available (per SDK 1.0.1 + Web Apps docs):
- DAT: Nav UP/DOWN/LEFT/RIGHT, Select, Back (source NEURAL_BAND), Drag DOWN/MOVE/UP with x,y,dx,dy
  (NEURAL_BAND_DRAG), display button onClick; Motion source enum has NEURAL_BAND (not observed yet).
- Web: Arrow keys (swipe, each preceded by keydown "Unidentified"), Enter (pinch), Back → history.back(),
  pointer drag only on a `touch-action:none` page, wrist quaternion via `emg-wrist` RelativeOrientationSensor.

## Still to verify on hardware
- After updating the DAT glasses app: session STARTED, camera/motion/inputs/display states, accel units in `dat_imu_still`.
- Pinch now activates tiles on the glasses; wrist sensor marker `__imuQuatWrapped` present.
