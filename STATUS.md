# Work status (updated 2026-11-04)

## Done
- `server/` recorder + dashboard; `relay` message lets the phone show prompts on the glasses Web App.
- `docs/` glasses Web App + dashboard (GitHub Pages: https://anoted.github.io/meta-glass-test/).
- `android/` DAT companion app complete (`App`, `MainActivity`, `LinkService`, `GlassLink`, `Uplink`, `DatTests`);
  `JAVA_HOME=~/.jdks/jdk-21.0.13+9 ./gradlew assembleDebug` builds `app/build/outputs/apk/debug/app-debug.apk`.
- `README.md`, `run.sh` (venv + Tailscale Funnel + server), `requirements.txt`.
- Tests: `./run.sh test` → 3 passed (pipeline, local API/static, source relay).

## Not yet verified on hardware
- Nothing has run on real glasses / Neural Band / phone. First real run: check DAT registration in Developer Mode,
  experimental capabilities (motion, inputs, speech, audio, photo) and the accel units guess in `dat_imu_still`.
