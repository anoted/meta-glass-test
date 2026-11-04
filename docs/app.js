/* Sensor Suite — Meta Ray-Ban Display Web App.
 * Probes, tests and streams every sensor and input the glasses runtime exposes
 * to a recorder PC over WebSocket (wss via Tailscale Funnel).
 *
 * Wire protocol (shared with the Android DAT app and the server):
 *   text  : JSON {t:"hello"|"batch"|"caps"|"test"|"test_suite"|"nb_test"|"log"|"ping"|"sync"|"marker", ...}
 *   batch : {t:"batch", items:[{s:<stream>, ts:<epoch ms>, ...}]}
 *   binary: [u8 kind][f64 ts_ms BE][u16 meta_len BE][meta JSON][payload]
 */
"use strict";
(() => {
const VERSION = "1.0.0";
const $ = (id) => document.getElementById(id);
const T0 = performance.timeOrigin || (Date.now() - performance.now());
const nowMs = () => T0 + performance.now();
const evMs = (e) => (e && e.timeStamp ? T0 + e.timeStamp : nowMs());
const r3 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 1000) / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = document.body.dataset.page || "main"; // "main" (index.html) or "drag" (drag.html)
const SID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8);

/* ------------------------------------------------------------------ config */
const store = {
  get(k, d) { try { const v = localStorage.getItem("mgt." + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mgt." + k, v); } catch {} },
};
const qs = new URLSearchParams(location.search);
if (qs.get("server")) store.set("server", qs.get("server"));
if (qs.get("key")) store.set("key", qs.get("key"));
const cfg = { server: store.get("server", ""), key: store.get("key", "") };

async function loadDefaultConfig() {
  if (cfg.server) return;
  try {
    const r = await fetch("config.json", { cache: "no-store" });
    const j = await r.json();
    if (j.server && !cfg.server) cfg.server = j.server;
  } catch {}
}
function wsUrl() {
  let h = (cfg.server || "").trim();
  if (!h) return null;
  if (!/^wss?:\/\//.test(h)) {
    h = h.replace(/^https?:\/\//, "");
    const local = /^(localhost|127\.|\[::1\])/.test(h);
    h = (local || location.protocol === "http:" ? "ws://" : "wss://") + h;
  }
  h = h.replace(/\/+$/, "");
  if (!/\/ws\/ingest$/.test(h)) h += "/ws/ingest";
  return `${h}?src=web&key=${encodeURIComponent(cfg.key)}`;
}

/* --------------------------------------------------------------- transport */
const net = {
  ws: null, state: "offline", queue: [], dropped: 0, sentBytes: 0, paused: false,
  rtt: null, offset: null, bestRtt: Infinity, pending: new Map(), retry: 500, handlers: {},
  connect() {
    const url = wsUrl();
    if (!url) { this.setState("no server"); return; }
    try { this.ws && this.ws.close(); } catch {}
    this.setState("connecting");
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.setState("bad url"); return; }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.setState("open");
      this.sendJson(helloMsg());
      if (caps.result) this.sendJson({ t: "caps", ts: nowMs(), caps: caps.result });
      this.flush();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setState("offline");
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => this.onMessage(ev);
  },
  setState(s) { this.state = s; ui.bar(); },
  open() { return this.ws && this.ws.readyState === 1; },
  sendJson(o) {
    if (!this.open()) return false;
    const s = JSON.stringify(o);
    this.sentBytes += s.length;
    this.ws.send(s);
    return true;
  },
  push(item) {
    if (this.paused) return;
    this.queue.push(item);
    stats.count(item.s);
    if (this.queue.length > 60000) { this.queue.splice(0, 10000); this.dropped += 10000; }
  },
  flush() {
    if (!this.open() || !this.queue.length) return;
    if (this.ws.bufferedAmount > 2e6) return; // link is saturated; keep queueing
    while (this.queue.length) {
      const items = this.queue.splice(0, 400);
      this.sendJson({ t: "batch", ts: nowMs(), items });
    }
  },
  sendBinary(kind, meta, payload) {
    if (!this.open() || this.ws.bufferedAmount > 4e6) return false;
    const m = new TextEncoder().encode(JSON.stringify(meta || {}));
    const p = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
    const buf = new ArrayBuffer(11 + m.length + p.byteLength);
    const dv = new DataView(buf);
    dv.setUint8(0, kind); dv.setFloat64(1, nowMs()); dv.setUint16(9, m.length);
    new Uint8Array(buf, 11, m.length).set(m);
    new Uint8Array(buf, 11 + m.length).set(p);
    this.ws.send(buf);
    this.sentBytes += buf.byteLength;
    return true;
  },
  ping() {
    if (!this.open()) return Promise.resolve(null);
    const id = Math.random().toString(36).slice(2, 9);
    const t0 = nowMs();
    return new Promise((res) => {
      this.pending.set(id, res);
      this.sendJson({ t: "ping", id, t0 });
      setTimeout(() => { if (this.pending.delete(id)) res(null); }, 5000);
    });
  },
  onMessage(ev) {
    if (typeof ev.data !== "string") { (this.handlers.binary || (() => {}))(ev.data); return; }
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "pong") {
      const t1 = nowMs();
      const rtt = t1 - m.t0, offset = m.ts - (m.t0 + t1) / 2;
      this.rtt = rtt;
      if (rtt <= this.bestRtt * 1.5 || this.offset == null) { this.offset = offset; this.bestRtt = Math.min(this.bestRtt, rtt); }
      const res = this.pending.get(m.id);
      if (res) { this.pending.delete(m.id); res({ rtt, offset, server: m.ts }); }
      return;
    }
    if (m.t === "welcome") { ui.recording = !!m.recording; ui.bar(); return; }
    if (m.t === "cmd") { remote(m.cmd, m.args || {}); return; }
    const h = this.handlers[m.t];
    if (h) h(m);
  },
};
setInterval(() => net.flush(), 100);
setInterval(async () => {
  const r = await net.ping();
  if (r) net.push({ s: "sync", ts: nowMs(), rtt: r3(r.rtt), offset: r3(r.offset), best_rtt: r3(net.bestRtt) });
}, 2000);

function helloMsg() {
  return {
    t: "hello", src: "web", app: "mrbd-sensor-suite-web", ver: VERSION, sid: SID, ts: nowMs(),
    info: {
      ua: navigator.userAgent, lang: navigator.language, platform: navigator.platform,
      uaData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null,
      hw: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
      screen: { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, dpr: devicePixelRatio, depth: screen.colorDepth },
      viewport: { w: innerWidth, h: innerHeight }, url: location.href.replace(/key=[^&]+/, "key=***"),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}

/* ------------------------------------------------------------------ stats */
const stats = {
  n: {}, prev: {}, rate: {},
  count(s) { this.n[s] = (this.n[s] || 0) + 1; },
  tick() {
    for (const k in this.n) { this.rate[k] = this.n[k] - (this.prev[k] || 0); }
    this.prev = { ...this.n };
  },
};
setInterval(() => { stats.tick(); ui.bar(); }, 1000);

/* --------------------------------------------------------------- sensors */
const live = { // latest values + ring buffers for on-glasses visualisation
  motion: null, orient: null, orientAbs: null, geo: null, battery: null,
  accel: [], gyro: [], max: 300, lastInput: "—", lastInputAt: 0,
};
const sensors = { motionOn: false, geoId: null, generic: {}, perm: { motion: "unknown", orientation: "unknown", geo: "unknown" } };

function onMotion(e) {
  const g = e.accelerationIncludingGravity || {}, a = e.acceleration || {}, r = e.rotationRate || {};
  const it = { s: "motion", ts: r3(evMs(e)), ax: r3(g.x), ay: r3(g.y), az: r3(g.z), lx: r3(a.x), ly: r3(a.y), lz: r3(a.z),
    ra: r3(r.alpha), rb: r3(r.beta), rg: r3(r.gamma), iv: r3(e.interval) };
  net.push(it);
  live.motion = it;
  live.accel.push([it.ax, it.ay, it.az]); if (live.accel.length > live.max) live.accel.shift();
  live.gyro.push([it.ra, it.rb, it.rg]); if (live.gyro.length > live.max) live.gyro.shift();
  bus.emit("motion", it);
}
function onOrient(e) {
  const it = { s: "orient", ts: r3(evMs(e)), a: r3(e.alpha), b: r3(e.beta), g: r3(e.gamma), abs: !!e.absolute };
  if (e.webkitCompassHeading != null) { it.hdg = r3(e.webkitCompassHeading); it.hdg_acc = r3(e.webkitCompassAccuracy); }
  net.push(it); live.orient = it; bus.emit("orient", it);
}
function onOrientAbs(e) {
  const it = { s: "orient_abs", ts: r3(evMs(e)), a: r3(e.alpha), b: r3(e.beta), g: r3(e.gamma), abs: !!e.absolute };
  net.push(it); live.orientAbs = it; bus.emit("orient_abs", it);
}

async function requestMotionPermission() {
  // Both constructors share ONE sensor permission on MRBD; call requestPermission() once, while the
  // click's user activation is still fresh (a second awaited call can lose it).
  const O = window.DeviceOrientationEvent, M = window.DeviceMotionEvent;
  const owner = typeof O?.requestPermission === "function" ? O : typeof M?.requestPermission === "function" ? M : null;
  let st;
  if (!O && !M) st = "unsupported";
  else if (!owner) st = "implicit";
  else { try { st = await owner.requestPermission(); } catch (e) { st = "error:" + (e && e.name); } }
  const out = { motion: M ? st : "unsupported", orientation: O ? st : "unsupported" };
  sensors.perm.motion = out.motion; sensors.perm.orientation = out.orientation;
  net.push({ s: "perm", ts: nowMs(), ...out });
  return out;
}
function startMotion() {
  if (sensors.motionOn) return;
  sensors.motionOn = true;
  addEventListener("devicemotion", onMotion);
  addEventListener("deviceorientation", onOrient);
  addEventListener("deviceorientationabsolute", onOrientAbs);
}
function startGeo() {
  if (!navigator.geolocation || sensors.geoId != null) return;
  sensors.geoId = navigator.geolocation.watchPosition((p) => {
    const c = p.coords;
    const it = { s: "geo", ts: r3(p.timestamp || nowMs()), lat: c.latitude, lon: c.longitude, acc: r3(c.accuracy), alt: r3(c.altitude),
      alt_acc: r3(c.altitudeAccuracy), hdg: r3(c.heading), spd: r3(c.speed) };
    net.push(it); live.geo = it; sensors.perm.geo = "granted"; bus.emit("geo", it);
  }, (err) => {
    net.push({ s: "geo_err", ts: nowMs(), code: err.code, msg: err.message });
    sensors.perm.geo = err.code === 1 ? "denied" : "error" + err.code;
    if (err.code === 1) { navigator.geolocation.clearWatch(sensors.geoId); sensors.geoId = null; }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

const GENERIC = [
  ["gs_accel", "Accelerometer"], ["gs_linacc", "LinearAccelerationSensor"], ["gs_gravity", "GravitySensor"],
  ["gs_gyro", "Gyroscope"], ["gs_mag", "Magnetometer"], ["gs_umag", "UncalibratedMagnetometer"],
  ["gs_absori", "AbsoluteOrientationSensor"], ["gs_relori", "RelativeOrientationSensor"], ["gs_light", "AmbientLightSensor"],
  ["gs_prox", "ProximitySensor"],
];
function startGeneric(stream, cls, freq = 60) {
  const C = window[cls];
  if (!C) return Promise.resolve({ status: "unsupported" });
  return new Promise((res) => {
    let s, done = false, n = 0;
    const finish = (r) => { if (!done) { done = true; res(r); } };
    try { s = cls === "AmbientLightSensor" || cls === "ProximitySensor" ? new C() : new C({ frequency: freq }); }
    catch (e) { finish({ status: "error", error: String(e && (e.name + ": " + e.message)) }); return; }
    s.onreading = () => {
      n++;
      const it = { s: stream, ts: r3(s.timestamp ? T0 + s.timestamp : nowMs()) };
      if (s.quaternion) { const [x, y, z, w] = s.quaternion; Object.assign(it, { qx: r3(x), qy: r3(y), qz: r3(z), qw: r3(w) }); }
      else if ("illuminance" in s) it.lux = r3(s.illuminance);
      else if ("distance" in s) { it.dist = r3(s.distance); it.near = s.near; }
      else if ("xBias" in s) Object.assign(it, { x: r3(s.x), y: r3(s.y), z: r3(s.z), xb: r3(s.xBias), yb: r3(s.yBias), zb: r3(s.zBias) });
      else Object.assign(it, { x: r3(s.x), y: r3(s.y), z: r3(s.z) });
      net.push(it);
      if (n === 1) finish({ status: "ok", sensor: s });
    };
    s.onerror = (e) => finish({ status: "error", error: e.error ? `${e.error.name}: ${e.error.message}` : "error" });
    try { s.start(); } catch (e) { finish({ status: "error", error: String(e) }); }
    sensors.generic[stream] = s;
    setTimeout(() => finish({ status: n ? "ok" : "no-readings", sensor: s }), 3000);
  });
}

/* Neural Band wrist orientation: RelativeOrientationSensor({sensorId:"emg-wrist"}). Only trust it when the
   glasses runtime has injected its marker (it lands a few hundred ms after load); otherwise the constructor is
   the browser's own and silently reports the HOST orientation. Quaternions arrive w-first [w,x,y,z]. */
const wrist = {
  s: null, state: "idle", n: 0, tries: 0, last: null,
  marker() { const C = window.RelativeOrientationSensor; return typeof C === "function" && C.__imuQuatWrapped === true; },
  async start() {
    if (this.s || this.state === "waiting") return this.state;
    this.state = "waiting";
    for (let i = 0; i < 50 && !this.marker(); i++) await sleep(100);
    if (!this.marker()) { this.state = "unavailable"; net.push({ s: "nb_wrist_state", ts: nowMs(), state: this.state }); return this.state; }
    try { this.s = new RelativeOrientationSensor({ sensorId: "emg-wrist", frequency: 60 }); }
    catch (e) { this.state = "error:" + e.name; net.push({ s: "nb_wrist_state", ts: nowMs(), state: this.state }); return this.state; }
    this.s.onreading = () => {
      const q = this.s.quaternion; if (!q) return;
      this.n++;
      const [w, x, y, z] = q;
      const it = { s: "nb_wrist", ts: r3(this.s.timestamp ? T0 + this.s.timestamp : nowMs()), qw: r3(w), qx: r3(x), qy: r3(y), qz: r3(z),
        twist: r3((2 * Math.atan2(y, w) * 180) / Math.PI) }; // roll about the forearm (+Y) axis, degrees
      net.push(it); this.last = it; bus.emit("nb_wrist", it);
    };
    this.s.onerror = (e) => {
      const name = e.error ? e.error.name : "error";
      net.push({ s: "nb_wrist_state", ts: nowMs(), state: "error", err: name, msg: e.error ? e.error.message : null });
      try { this.s.stop(); } catch {}
      this.s = null; this.state = "error:" + name;
      // NotReadableError usually means the band is not worn; retry with backoff.
      if (name === "NotReadableError" && this.tries++ < 6) setTimeout(() => this.start(), 2000 * this.tries);
    };
    this.s.start(); this.state = "running";
    net.push({ s: "nb_wrist_state", ts: nowMs(), state: this.state });
    return this.state;
  },
};

async function startBattery() {
  if (!navigator.getBattery) return null;
  try {
    const b = await navigator.getBattery();
    const emit = (ev) => { const it = { s: "battery", ts: nowMs(), ev, level: b.level, charging: b.charging, ct: b.chargingTime, dt: b.dischargingTime }; live.battery = it; net.push(it); ui.bar(); };
    ["levelchange", "chargingchange", "chargingtimechange", "dischargingtimechange"].forEach((n) => b.addEventListener(n, () => emit(n)));
    emit("init"); setInterval(() => emit("poll"), 30000);
    return b;
  } catch { return null; }
}
function netInfo() {
  const c = navigator.connection || {};
  return { s: "net", ts: nowMs(), online: navigator.onLine, type: c.type, eff: c.effectiveType, down: c.downlink, down_max: c.downlinkMax, rtt: c.rtt, save: c.saveData };
}
function startNetInfo() {
  net.push(netInfo());
  if (navigator.connection) navigator.connection.addEventListener("change", () => net.push(netInfo()));
  setInterval(() => net.push(netInfo()), 10000);
}

/* perf: fps, event-loop lag, memory, long tasks */
const perf = { frames: 0, lagMax: 0, longTasks: 0, longMs: 0, fps: 0 };
(function rafLoop() { perf.frames++; requestAnimationFrame(rafLoop); })();
(function lagLoop() { let last = performance.now(); setInterval(() => { const n = performance.now(); perf.lagMax = Math.max(perf.lagMax, n - last - 100); last = n; }, 100); })();
try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { perf.longTasks++; perf.longMs += e.duration; })).observe({ type: "longtask", buffered: true }); } catch {}
setInterval(() => {
  const m = performance.memory || {};
  perf.fps = perf.frames;
  net.push({ s: "perf", ts: nowMs(), fps: perf.frames, lag: r3(perf.lagMax), long_n: perf.longTasks, long_ms: r3(perf.longMs), heap: m.usedJSHeapSize, heap_lim: m.jsHeapSizeLimit,
    q: net.queue.length, drop: net.dropped, ws_buf: net.ws ? net.ws.bufferedAmount : null, sent: net.sentBytes, vis: document.visibilityState });
  perf.frames = 0; perf.lagMax = 0; perf.longTasks = 0; perf.longMs = 0;
}, 1000);

/* lifecycle */
["visibilitychange", "pagehide", "pageshow", "freeze", "resume", "focus", "blur", "online", "offline", "resize", "orientationchange", "beforeunload"].forEach((n) =>
  (n === "visibilitychange" || n === "freeze" || n === "resume" ? document : window).addEventListener(n, (e) =>
    net.push({ s: "life", ts: r3(evMs(e)), ev: n, vis: document.visibilityState, w: innerWidth, h: innerHeight })));

/* --------------------------------------------------------------- inputs */
const bus = { h: {}, on(n, f) { (this.h[n] ||= new Set()).add(f); return () => this.h[n].delete(f); }, emit(n, v) { (this.h[n] || []).forEach((f) => f(v)); } };
const tgt = (e) => (e.target && (e.target.id || e.target.dataset?.go || e.target.dataset?.act || e.target.tagName)) || null;
function logInput(e, extra) {
  const it = { s: "input", ts: r3(evMs(e)), ev: e.type, tgt: tgt(e), scr: ui.screen, ...extra };
  net.push(it); bus.emit("input", it);
  if (e.type === "keydown" || e.type === "click" || e.type === "pointerdown" || e.type === "wheel") {
    live.lastInput = e.type === "wheel" ? `wheel ${extra.dx},${extra.dy}` : `${e.type} ${extra.key || ""}`.trim(); live.lastInputAt = nowMs();
  }
  return it;
}
const keyAt = { enter: 0 }; // wall time (dispatch) of the last Enter keydown, for pinch de-duplication
addEventListener("keydown", (e) => { if (e.key === "Enter") keyAt.enter = nowMs(); }, true);
// No free cursor on MRBD: if the host still sends a pointer press (e.g. a pinch in drag mode), do not let it
// move focus off the selected control, or the Enter that follows hits <body>. Text fields keep their default.
if (PAGE === "main") addEventListener("pointerdown", (e) => { if (!e.target.closest?.("input,textarea,[contenteditable]")) e.preventDefault(); }, true);
addEventListener("keydown", (e) => logInput(e, { key: e.key, code: e.code, kc: e.keyCode, rep: e.repeat, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }), true);
addEventListener("keyup", (e) => logInput(e, { key: e.key, code: e.code, kc: e.keyCode }), true);
addEventListener("click", (e) => logInput(e, { x: r3(e.clientX), y: r3(e.clientY), det: e.detail, pt: e.pointerType || null }), true);
for (const n of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerover", "pointerout", "gotpointercapture", "lostpointercapture"]) {
  addEventListener(n, (e) => logInput(e, { x: r3(e.clientX), y: r3(e.clientY), pid: e.pointerId, pt: e.pointerType, prs: r3(e.pressure), btn: e.buttons,
    w: r3(e.width), h: r3(e.height), tx: e.tiltX, ty: e.tiltY, prim: e.isPrimary }), true);
}
for (const n of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
  addEventListener(n, (e) => logInput(e, { touches: [...e.changedTouches].map((t) => [t.identifier, r3(t.clientX), r3(t.clientY), r3(t.force)]) }), { capture: true, passive: true });
}
addEventListener("wheel", (e) => logInput(e, { dx: r3(e.deltaX), dy: r3(e.deltaY), dz: r3(e.deltaZ), mode: e.deltaMode }), { capture: true, passive: true });
addEventListener("contextmenu", (e) => logInput(e, {}), true);
addEventListener("focusin", (e) => logInput(e, {}), true);
for (const n of ["input", "change", "compositionstart", "compositionupdate", "compositionend", "beforeinput"]) {
  addEventListener(n, (e) => logInput(e, { val: e.target && "value" in e.target ? String(e.target.value).slice(0, 500) : null, data: e.data ?? null, it: e.inputType || null }), true);
}
addEventListener("popstate", (e) => net.push({ s: "input", ts: r3(evMs(e)), ev: "popstate", state: e.state && e.state.screen, scr: ui.screen }));
addEventListener("gamepadconnected", (e) => net.push({ s: "input", ts: nowMs(), ev: "gamepadconnected", id: e.gamepad.id }));
setInterval(() => {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  pads.forEach((p) => net.push({ s: "gamepad", ts: r3(T0 + p.timestamp), i: p.index, id: p.id, ax: p.axes.map(r3), bt: p.buttons.map((b) => r3(b.value)) }));
}, 50);

/* --------------------------------------------------------- capabilities */
const caps = {
  result: null,
  async probe() {
    const has = (o, k) => { try { return o != null && k in o; } catch { return false; } };
    const r = {};
    const put = (k, ok, detail) => { r[k] = { ok: !!ok, detail: detail ?? null }; };
    put("DeviceMotionEvent", has(window, "DeviceMotionEvent"), typeof window.DeviceMotionEvent?.requestPermission === "function" ? "requestPermission()" : "no-permission-api");
    put("DeviceOrientationEvent", has(window, "DeviceOrientationEvent"));
    put("deviceorientationabsolute", "ondeviceorientationabsolute" in window);
    GENERIC.forEach(([, c]) => put("GenericSensor." + c, has(window, c)));
    put("geolocation", has(navigator, "geolocation"));
    put("getBattery", has(navigator, "getBattery"));
    put("NetworkInformation", has(navigator, "connection"), navigator.connection ? navigator.connection.effectiveType : null);
    put("speechSynthesis", has(window, "speechSynthesis"), window.speechSynthesis ? speechSynthesis.getVoices().map((v) => v.name).join("|") || "voices-pending" : null);
    put("SpeechRecognition", has(window, "SpeechRecognition") || has(window, "webkitSpeechRecognition"));
    put("mediaDevices.getUserMedia", !!navigator.mediaDevices?.getUserMedia);
    try { const d = await navigator.mediaDevices?.enumerateDevices(); put("enumerateDevices", !!d, d ? d.map((x) => x.kind + ":" + (x.label || "?")).join(", ") : null); } catch (e) { put("enumerateDevices", false, String(e)); }
    put("MediaRecorder", has(window, "MediaRecorder"));
    put("AudioContext", has(window, "AudioContext") || has(window, "webkitAudioContext"));
    put("RTCPeerConnection", has(window, "RTCPeerConnection"));
    put("WebSocket", has(window, "WebSocket"));
    put("WebTransport", has(window, "WebTransport"));
    put("fetch", has(window, "fetch"));
    put("serviceWorker", has(navigator, "serviceWorker"));
    put("caches", has(window, "caches"));
    put("indexedDB", has(window, "indexedDB"));
    put("localStorage", (() => { try { localStorage.setItem("_t", "1"); localStorage.removeItem("_t"); return true; } catch { return false; } })());
    try { const e = await navigator.storage?.estimate(); put("storage.estimate", !!e, e ? `${Math.round(e.usage / 1024)}KiB / ${Math.round(e.quota / 1048576)}MiB` : null); } catch { put("storage.estimate", false); }
    put("wakeLock", has(navigator, "wakeLock"));
    put("vibrate", has(navigator, "vibrate"));
    put("bluetooth", has(navigator, "bluetooth"));
    put("usb", has(navigator, "usb")); put("hid", has(navigator, "hid")); put("serial", has(navigator, "serial"));
    put("NDEFReader", has(window, "NDEFReader"));
    put("share", has(navigator, "share")); put("clipboard", has(navigator, "clipboard"));
    put("Notification", has(window, "Notification"), window.Notification ? Notification.permission : null);
    put("getGamepads", has(navigator, "getGamepads"));
    put("requestPointerLock", has(Element.prototype, "requestPointerLock"));
    put("requestFullscreen", has(Element.prototype, "requestFullscreen"));
    put("navigation API", has(window, "navigation"), window.navigation ? "canGoBack=" + navigation.canGoBack : null);
    put("navigator.install", has(navigator, "install"));
    put("PerformanceObserver.longtask", (PerformanceObserver.supportedEntryTypes || []).includes("longtask"));
    put("performance.memory", has(performance, "memory"));
    put("Worker", has(window, "Worker")); put("SharedArrayBuffer", has(window, "SharedArrayBuffer"));
    put("WebAssembly", has(window, "WebAssembly"));
    put("OffscreenCanvas", has(window, "OffscreenCanvas"));
    try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl");
      const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
      put("WebGL", !!gl, gl ? `${gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl1"} ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ""}` : null); } catch { put("WebGL", false); }
    put("WebGPU", has(navigator, "gpu"));
    put("EyeDropper", has(window, "EyeDropper")); put("XR (navigator.xr)", has(navigator, "xr"));
    put("matchMedia.dark", matchMedia("(prefers-color-scheme: dark)").matches);
    put("matchMedia.reducedMotion", matchMedia("(prefers-reduced-motion: reduce)").matches);
    put("matchMedia.pointer", matchMedia("(pointer: fine)").matches ? "fine" : matchMedia("(pointer: coarse)").matches ? "coarse" : "none");
    put("touch", "ontouchstart" in window, "maxTouchPoints=" + navigator.maxTouchPoints);
    for (const n of ["geolocation", "accelerometer", "gyroscope", "magnetometer", "ambient-light-sensor", "camera", "microphone", "notifications"]) {
      try { const p = await navigator.permissions.query({ name: n }); put("permission." + n, true, p.state); } catch { put("permission." + n, false, "not queryable"); }
    }
    this.result = r;
    net.sendJson({ t: "caps", ts: nowMs(), caps: r });
    return r;
  },
};

/* ---------------------------------------------------------------- media */
const media = {
  stream: null, timer: null, rec: null, ac: null,
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia unsupported");
    const s = await withTimeout(navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true }), 8000, "getUserMedia timeout");
    this.stream = s;
    const v = $("cam"); v.srcObject = s; await v.play().catch(() => {});
    const cv = document.createElement("canvas"); cv.width = 320; cv.height = 240; const cx = cv.getContext("2d");
    if (s.getVideoTracks().length) this.timer = setInterval(() => {
      if (!v.videoWidth) return;
      cx.drawImage(v, 0, 0, cv.width, cv.height);
      cv.toBlob(async (b) => b && net.sendBinary(3, { ext: "jpg", w: cv.width, h: cv.height }, new Uint8Array(await b.arrayBuffer())), "image/jpeg", 0.6);
    }, 200);
    if (s.getAudioTracks().length && window.MediaRecorder) {
      this.rec = new MediaRecorder(new MediaStream(s.getAudioTracks()), { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "" });
      this.rec.ondataavailable = async (e) => e.data.size && net.sendBinary(5, { mime: this.rec.mimeType }, new Uint8Array(await e.data.arrayBuffer()));
      this.rec.start(1000);
      try {
        this.ac = new (window.AudioContext || window.webkitAudioContext)();
        const an = this.ac.createAnalyser(); an.fftSize = 1024; this.ac.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        this.levelTimer = setInterval(() => { an.getFloatTimeDomainData(buf); let q = 0; for (const x of buf) q += x * x; net.push({ s: "audio_level", ts: nowMs(), rms: r3(Math.sqrt(q / buf.length)) }); }, 100);
      } catch {}
    }
    net.push({ s: "media", ts: nowMs(), ev: "start", tracks: s.getTracks().map((t) => ({ kind: t.kind, label: t.label, settings: t.getSettings ? t.getSettings() : null })) });
    return s;
  },
  stop() {
    clearInterval(this.timer); clearInterval(this.levelTimer);
    try { this.rec && this.rec.stop(); } catch {}
    this.stream && this.stream.getTracks().forEach((t) => t.stop());
    try { this.ac && this.ac.close(); } catch {}
    this.stream = this.rec = this.ac = null;
    net.push({ s: "media", ts: nowMs(), ev: "stop" });
  },
};
function withTimeout(p, ms, msg) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || "timeout")), ms))]); }

/* ------------------------------------------------------------------ TTS */
function speak(text) {
  return new Promise((res) => {
    if (!window.speechSynthesis) { res({ ok: false, error: "unsupported" }); return; }
    const u = new SpeechSynthesisUtterance(text);
    const t0 = nowMs(); let tStart = null;
    const ev = (n, extra = {}) => net.push({ s: "tts", ts: nowMs(), ev: n, text: text.slice(0, 80), ...extra });
    u.onstart = () => { tStart = nowMs(); ev("start", { lat: r3(tStart - t0) }); };
    u.onend = () => { ev("end", { dur: r3(nowMs() - (tStart || t0)) }); res({ ok: true, startLatency: tStart ? tStart - t0 : null, duration: nowMs() - (tStart || t0) }); };
    u.onerror = (e) => { ev("error", { err: e.error }); res({ ok: false, error: e.error }); };
    ev("speak");
    try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { res({ ok: false, error: String(e) }); }
    setTimeout(() => res({ ok: tStart != null, error: tStart ? null : "no start event in 10s" }), 10000);
  });
}

/* ------------------------------------------------------------------- UI */
const ui = {
  screen: "home", recording: false,
  show(name) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === "s-" + name));
    const prev = this.screen; this.screen = name;
    net.push({ s: "ui", ts: nowMs(), screen: name, from: prev });
    screens[prev]?.leave?.(); screens[name]?.enter?.();
  },
  bar() {
    const st = net.state;
    $("link-dot").className = "dot " + (st === "open" ? "ok" : st === "connecting" ? "wait" : "");
    $("link-txt").textContent = st === "open" ? `link ${net.rtt != null ? Math.round(net.rtt) + "ms" : ""}` : st;
    const tot = Object.values(stats.rate).reduce((a, b) => a + b, 0);
    $("rate-txt").textContent = net.paused ? "paused" : `${tot}/s`;
    $("rec-txt").textContent = ui.recording && st === "open" ? "● REC" : "";
    $("bat-txt").textContent = live.battery ? `${Math.round(live.battery.level * 100)}%${live.battery.charging ? "+" : ""}` : "";
    $("clock-txt").textContent = new Date().toTimeString().slice(0, 5);
  },
  toast(text, ms = 3500) {
    const t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(this._tt); this._tt = setTimeout(() => (t.hidden = true), ms);
  },
};

function go(name) {
  if (ui.screen !== "home") { ui.show(name); history.replaceState({ screen: name }, ""); return; }
  history.pushState({ screen: name }, "");
  ui.show(name);
}
addEventListener("popstate", (e) => ui.show((e.state && e.state.screen) || "home"));
function activate(b) {
  if (b.dataset.go) go(b.dataset.go);
  if (b.dataset.act) actions[b.dataset.act]?.(b);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button,[data-go],[data-act]"); if (!b) return;
  if (e.detail === 0) { activate(b); return; } // keyboard / Enter activation of the focused control
  // A pointer click: on the glasses a pinch can produce BOTH a click at screen centre and an Enter; act on
  // the pointer click only if no Enter arrives right after it (desktop mouse testing still works).
  const t = nowMs();
  setTimeout(() => { if (keyAt.enter < t - 60) activate(b); }, 180);
});

const actions = {
  async enable(b) {
    const p = await requestMotionPermission();
    startMotion(); startGeo();
    const w = await wrist.start();
    if (b) { b.classList.add("done"); b.querySelector("small").textContent = `motion:${p.motion} · wrist:${w}`; }
    ui.toast(`Sensors on · wrist ${w}`);
  },
  save() {
    cfg.server = $("in-server").value.trim(); cfg.key = $("in-key").value.trim();
    store.set("server", cfg.server); store.set("key", cfg.key);
    net.connect(); ui.toast("Reconnecting…");
  },
  async media(b) {
    if (media.stream) { media.stop(); b.textContent = "Camera / mic"; return; }
    try { await media.start(); b.textContent = "Stop camera"; ui.toast("Camera/mic streaming"); }
    catch (e) { ui.toast("Camera/mic: " + e.message); net.push({ s: "media", ts: nowMs(), ev: "error", err: String(e.name + ": " + e.message) }); }
  },
  async speak() { const r = await speak("Sensor suite speech test."); ui.toast(r.ok ? `TTS ok, start ${Math.round(r.startLatency)} ms` : "TTS: " + r.error); },
  dragpage() { location.href = "drag.html" + location.search; }, // separate load: only that page opts into drag
  pause(b) { net.paused = !net.paused; b.textContent = net.paused ? "Resume stream" : "Pause stream"; ui.bar(); },
};

/* ------------------------------------------------------ live visualisation */
const screens = {};
screens.live = {
  enter() { this.on = true; this.draw(); },
  leave() { this.on = false; },
  draw() {
    if (!this.on) return;
    const cv = $("live-cv"), c = cv.getContext("2d"), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    c.font = "15px 'IBM Plex Mono', monospace";
    const cols = ["#46d7ff", "#ff9a4a", "#6dffb0"];
    const strip = (data, y0, h, range, label, names) => {
      c.strokeStyle = "#2a2a2a"; c.lineWidth = 1; c.strokeRect(0.5, y0 + 0.5, 380, h);
      c.beginPath(); c.moveTo(0, y0 + h / 2); c.lineTo(380, y0 + h / 2); c.stroke();
      for (let k = 0; k < 3; k++) {
        c.strokeStyle = cols[k]; c.lineWidth = 2; c.beginPath();
        data.forEach((v, i) => { const x = (i / live.max) * 380, y = y0 + h / 2 - ((v[k] ?? 0) / range) * (h / 2); i ? c.lineTo(x, y) : c.moveTo(x, y); });
        c.stroke();
      }
      const last = data[data.length - 1] || [];
      c.fillStyle = "#b9b9b0"; c.fillText(label, 6, y0 + 18);
      names.forEach((n, k) => { c.fillStyle = cols[k]; c.fillText(`${n} ${last[k] == null ? "–" : last[k].toFixed(2)}`, 6 + k * 124, y0 + h - 8); });
    };
    strip(live.accel, 0, 230, 20, "accel incl. g  m/s²  ±20", ["x", "y", "z"]);
    strip(live.gyro, 245, 230, 360, "rotation rate  °/s  ±360", ["α", "β", "γ"]);
    // horizon (beta = pitch, gamma = roll)
    const o = live.orient || {}, cx = 490, cy = 110, R = 95;
    c.save(); c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
    c.translate(cx, cy); c.rotate(-((o.g || 0) * Math.PI) / 180);
    const off = Math.max(-R, Math.min(R, ((o.b || 0) / 90) * R));
    c.fillStyle = "#103040"; c.fillRect(-R * 2, -R * 2 + off, R * 4, R * 2);
    c.strokeStyle = "#46d7ff"; c.lineWidth = 2; c.beginPath(); c.moveTo(-R, off); c.lineTo(R, off); c.stroke();
    c.restore();
    c.strokeStyle = "#f4f4f0"; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx - 30, cy); c.lineTo(cx + 30, cy); c.stroke();
    c.fillStyle = "#b9b9b0"; c.fillText(`β ${o.b == null ? "–" : o.b.toFixed(1)}  γ ${o.g == null ? "–" : o.g.toFixed(1)}`, 400, 228);
    // compass (alpha / absolute heading)
    const abs = live.orientAbs || o, hdg = abs.hdg ?? (abs.a == null ? null : (360 - abs.a) % 360), qy = 360;
    c.strokeStyle = "#f4f4f0"; c.beginPath(); c.arc(cx, qy, R, 0, Math.PI * 2); c.stroke();
    if (hdg != null) {
      c.save(); c.translate(cx, qy); c.rotate((-hdg * Math.PI) / 180);
      c.fillStyle = "#ff6b6b"; c.font = "bold 20px 'STIX Two Text', serif"; c.fillText("N", -7, -R + 24);
      c.fillStyle = "#b9b9b0"; c.fillText("S", -6, R - 10); c.fillText("E", R - 22, 7); c.fillText("W", -R + 8, 7);
      c.restore();
    }
    c.strokeStyle = "#ffd84a"; c.lineWidth = 3; c.beginPath(); c.moveTo(cx, qy - R + 4); c.lineTo(cx, qy - R + 30); c.stroke();
    c.font = "15px 'IBM Plex Mono', monospace"; c.fillStyle = "#b9b9b0";
    c.fillText(`hdg ${hdg == null ? "–" : hdg.toFixed(0) + "°"} ${abs.abs ? "abs" : "rel"}`, 410, 478);
    const g = live.geo;
    const wl = wrist.last;
    $("live-last").textContent = `${live.lastInput} · ${wl ? `wrist ${wl.twist.toFixed(0)}°` : "wrist " + wrist.state} · ${g ? `${g.lat.toFixed(4)},${g.lon.toFixed(4)} ±${Math.round(g.acc)}m` : "no GPS"}`;
    requestAnimationFrame(() => this.draw());
  },
};

screens.drag = {
  enter() {
    this.pts = []; this.n = 0; this.on = true;
    const cv = $("drag-cv"); const c = cv.getContext("2d");
    const rect = () => cv.getBoundingClientRect();
    this.off = [
      bus.on("input", (it) => {
        if (!it.ev.startsWith("pointer") && !it.ev.startsWith("touch")) return;
        if (it.x == null) return;
        const r = rect(); const x = ((it.x - r.left) / r.width) * cv.width, y = ((it.y - r.top) / r.height) * cv.height;
        if (it.ev === "pointerdown") this.pts.push(null);
        if (it.ev === "pointermove" || it.ev === "pointerdown") { this.pts.push([x, y]); this.n++; }
        $("drag-info").textContent = `${it.ev}  x ${it.x.toFixed(0)}  y ${it.y.toFixed(0)}  btn ${it.btn ?? "-"}  n ${this.n}`;
      }),
    ];
    cv.onpointerdown = (e) => { try { cv.setPointerCapture(e.pointerId); } catch {} };
    const draw = () => {
      if (!this.on) return;
      c.clearRect(0, 0, cv.width, cv.height);
      c.strokeStyle = "#2a2a2a"; c.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
      c.strokeStyle = "#46d7ff"; c.lineWidth = 3; c.beginPath();
      let pen = false;
      for (const p of this.pts.slice(-2000)) { if (!p) { pen = false; continue; } pen ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); pen = true; }
      c.stroke();
      requestAnimationFrame(draw);
    };
    draw();
  },
  leave() { this.on = false; (this.off || []).forEach((f) => f()); },
};

screens.setup = {
  enter() {
    $("in-server").value = cfg.server; $("in-key").value = cfg.key;
    const p = sensors.perm;
    $("setup-info").textContent = `sid ${SID}  v${VERSION}\nws ${net.state}  rtt ${net.rtt ? net.rtt.toFixed(0) : "-"}ms  offset ${net.offset ? net.offset.toFixed(0) : "-"}ms\nperm motion:${p.motion} orient:${p.orientation} geo:${p.geo}\nviewport ${innerWidth}x${innerHeight} dpr ${devicePixelRatio}`;
    $("b-save").focus();
  },
};
screens.home = { enter() { setTimeout(() => (document.querySelector("#s-home .tile:not(.done)") || $("b-enable")).focus(), 30); } };

/* ------------------------------------------------------------ test suite */
const suite = { running: false, abort: false };
function tPrompt(text, frac) { $("t-prompt").textContent = text; if (frac != null) $("t-fill").style.width = Math.round(frac * 100) + "%"; }
async function countdown(sec, text) {
  const t0 = performance.now();
  while (!suite.abort) {
    const el = (performance.now() - t0) / 1000;
    if (el >= sec) break;
    tPrompt(`${text}  ${Math.ceil(sec - el)}s`, el / sec);
    await sleep(100);
  }
  $("t-fill").style.width = "100%";
}
function collect(stream) { const arr = []; const off = bus.on(stream, (v) => arr.push(v)); return { arr, stop: off }; }
const stat = (xs) => {
  const v = xs.filter((x) => x != null && !Number.isNaN(x)); if (!v.length) return { n: 0 };
  const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  const s = [...v].sort((a, b) => a - b);
  return { n: v.length, mean: r3(m), sd: r3(sd), min: r3(s[0]), max: r3(s[s.length - 1]), p50: r3(s[s.length >> 1]), p95: r3(s[Math.floor(s.length * 0.95)]) };
};
function rateOf(arr) {
  if (arr.length < 3) return { hz: 0 };
  const dt = []; for (let i = 1; i < arr.length; i++) dt.push(arr[i].ts - arr[i - 1].ts);
  const span = (arr[arr.length - 1].ts - arr[0].ts) / 1000;
  return { hz: r3((arr.length - 1) / span), dt: stat(dt) };
}
function integrateRot(arr) { // integrate rotationRate (deg/s) per axis -> span of angle per axis
  const ang = [0, 0, 0], lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 1; i < arr.length; i++) {
    const dt = (arr[i].ts - arr[i - 1].ts) / 1000; if (dt <= 0 || dt > 0.5) continue;
    ["ra", "rb", "rg"].forEach((k, j) => { ang[j] += (arr[i][k] || 0) * dt; lo[j] = Math.min(lo[j], ang[j]); hi[j] = Math.max(hi[j], ang[j]); });
  }
  return hi.map((h, j) => r3(h - lo[j]));
}
function orientSpan(arr, k) { // unwrap angle and return span
  let prev = null, acc = 0, lo = 0, hi = 0;
  for (const o of arr) { const v = o[k]; if (v == null) continue; if (prev != null) { let d = v - prev; if (d > 180) d -= 360; if (d < -180) d += 360; acc += d; lo = Math.min(lo, acc); hi = Math.max(hi, acc); } prev = v; }
  return r3(hi - lo);
}

const TESTS = [
  ["capabilities", "Probe browser APIs", async () => {
    const r = await caps.probe(); const ok = Object.values(r).filter((x) => x.ok).length;
    return { status: "pass", metrics: { supported: ok, total: Object.keys(r).length } };
  }],
  ["motion_permission", "Motion & orientation permission", async () => {
    tPrompt("Allow motion access if asked");
    const p = await requestMotionPermission(); startMotion();
    const good = (v) => v === "granted" || v === "implicit";
    return { status: good(p.motion) && good(p.orientation) ? "pass" : "fail", metrics: p };
  }],
  ["imu_still", "IMU at rest (rate, noise, gravity)", async () => {
    const m = collect("motion"), o = collect("orient");
    await countdown(6, "Hold your head STILL");
    m.stop(); o.stop();
    if (!m.arr.length) return { status: "fail", notes: "no devicemotion events" };
    const g = m.arr.map((x) => (x.ax == null ? null : Math.hypot(x.ax, x.ay, x.az)));
    const nulls = (k) => r3(m.arr.filter((x) => x[k] == null).length / m.arr.length);
    const gm = stat(g);
    const metrics = { motion: rateOf(m.arr), orient: rateOf(o.arr), g_mag: gm,
      gyro_bias: { a: stat(m.arr.map((x) => x.ra)).mean, b: stat(m.arr.map((x) => x.rb)).mean, g: stat(m.arr.map((x) => x.rg)).mean },
      gyro_noise_sd: { a: stat(m.arr.map((x) => x.ra)).sd, b: stat(m.arr.map((x) => x.rb)).sd, g: stat(m.arr.map((x) => x.rg)).sd },
      accel_noise_sd: { x: stat(m.arr.map((x) => x.ax)).sd, y: stat(m.arr.map((x) => x.ay)).sd, z: stat(m.arr.map((x) => x.az)).sd },
      null_frac: { accG: nulls("ax"), acc: nulls("lx"), rot: nulls("ra") }, interval_ms: stat(m.arr.map((x) => x.iv)),
      mean_gravity_vec: { x: stat(m.arr.map((x) => x.ax)).mean, y: stat(m.arr.map((x) => x.ay)).mean, z: stat(m.arr.map((x) => x.az)).mean } };
    const okG = gm.mean > 8.8 && gm.mean < 10.8, okR = metrics.motion.hz >= 15;
    return { status: okG && okR ? "pass" : "warn", metrics, notes: `${metrics.motion.hz} Hz, |g|=${gm.mean}` };
  }],
  ...[["head_yaw", "Turn head LEFT, then RIGHT"], ["head_pitch", "NOD: look UP, then DOWN"], ["head_roll", "TILT head to LEFT & RIGHT shoulder"]].map(([name, prompt]) =>
    [name, prompt, async () => {
      const m = collect("motion"), o = collect("orient");
      await countdown(7, prompt);
      m.stop(); o.stop();
      if (!m.arr.length) return { status: "fail", notes: "no motion" };
      const rot = integrateRot(m.arr); const dom = ["alpha", "beta", "gamma"][rot.indexOf(Math.max(...rot))];
      const spans = { alpha: orientSpan(o.arr, "a"), beta: orientSpan(o.arr, "b"), gamma: orientSpan(o.arr, "g") };
      const max = Math.max(...rot);
      return { status: max > 30 ? "pass" : "warn", metrics: { rot_span_deg: { alpha: rot[0], beta: rot[1], gamma: rot[2] }, dominant_rotation_axis: dom, orient_span_deg: spans }, notes: `dominant ${dom} ${max.toFixed(0)}°` };
    }]),
  ["compass", "Absolute orientation / compass", async () => {
    const a = collect("orient_abs"); const o = collect("orient");
    await countdown(3, "Look around slowly");
    a.stop(); o.stop();
    const absEvents = a.arr.length, absFlag = o.arr.some((x) => x.abs), hdg = o.arr.some((x) => x.hdg != null);
    return { status: absEvents || absFlag || hdg ? "pass" : "unsupported", metrics: { orient_abs: rateOf(a.arr), orient_absolute_flag: absFlag, webkitCompassHeading: hdg } };
  }],
  ["generic_sensors", "Generic Sensor API (accel, gyro, mag, light…)", async () => {
    const res = {};
    for (const [stream, cls] of GENERIC) { tPrompt(`Starting ${cls}…`); const r = await startGeneric(stream, cls); res[cls] = r.error ? `${r.status}: ${r.error}` : r.status; }
    const ok = Object.values(res).filter((v) => v === "ok").length;
    return { status: ok ? "pass" : "unsupported", metrics: res, notes: `${ok}/${GENERIC.length} delivering` };
  }],
  ["geolocation", "Location (via paired phone)", async () => {
    if (!navigator.geolocation) return { status: "unsupported" };
    tPrompt("Getting location (up to 15 s)…");
    const t0 = nowMs();
    const r = await new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res({ ok: true, p }), (e) => res({ ok: false, e }), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }));
    startGeo();
    if (!r.ok) return { status: r.e.code === 1 ? "fail" : "warn", metrics: { code: r.e.code, msg: r.e.message, ms: r3(nowMs() - t0) } };
    const c = r.p.coords;
    return { status: "pass", metrics: { ms_to_fix: r3(nowMs() - t0), lat: c.latitude, lon: c.longitude, acc_m: c.accuracy, alt: c.altitude, speed: c.speed, heading: c.heading } };
  }],
  ["battery", "Battery status", async () => {
    if (!navigator.getBattery) return { status: "unsupported" };
    const b = await navigator.getBattery();
    return { status: "pass", metrics: { level: b.level, charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime } };
  }],
  ["network_info", "Network information", async () => ({ status: navigator.connection ? "pass" : "unsupported", metrics: netInfo() })],
  ["latency", "Round-trip latency + clock offset (30 pings)", async () => {
    if (!net.open()) return { status: "fail", notes: "not connected" };
    const rt = [], off = [];
    for (let i = 0; i < 30 && !suite.abort; i++) { tPrompt(`ping ${i + 1}/30`, i / 30); const r = await net.ping(); if (r) { rt.push(r.rtt); off.push(r.offset); } await sleep(60); }
    const s = stat(rt);
    return { status: rt.length >= 25 ? "pass" : "warn", metrics: { rtt_ms: s, offset_ms: stat(off), lost: 30 - rt.length }, notes: `rtt p50 ${s.p50} ms` };
  }],
  ["uplink", "Uplink throughput (glasses → PC)", async () => {
    if (!net.open()) return { status: "fail" };
    const id = "u" + Date.now(), n = 24, size = 65536;
    const done = new Promise((res) => { net.handlers.tput_result = (m) => m.id === id && res(m); setTimeout(() => res(null), 20000); });
    net.sendJson({ t: "tput_begin", id, n, size });
    const payload = new Uint8Array(size); crypto.getRandomValues(payload.subarray(0, 65536));
    const t0 = nowMs();
    for (let i = 0; i < n; i++) { while (net.ws.bufferedAmount > 1e6) await sleep(5); net.sendBinary(9, { id, i }, payload); tPrompt(`sending ${i + 1}/${n}`, i / n); }
    const r = await done;
    if (!r) return { status: "fail", notes: "no result" };
    return { status: "pass", metrics: { mbps_server: r3(r.mbps), bytes: r.bytes, client_ms: r3(nowMs() - t0) }, notes: `${r.mbps.toFixed(2)} Mbit/s` };
  }],
  ["downlink", "Downlink throughput (PC → glasses)", async () => {
    if (!net.open()) return { status: "fail" };
    const id = "d" + Date.now(); let bytes = 0, t0 = 0, n = 0;
    const done = new Promise((res) => {
      net.handlers.tput_down_begin = (m) => { if (m.id === id) t0 = nowMs(); };
      net.handlers.binary = (buf) => { if (!t0) t0 = nowMs(); bytes += buf.byteLength; n++; };
      net.handlers.tput_down_end = (m) => m.id === id && res(nowMs());
      setTimeout(() => res(null), 20000);
    });
    tPrompt("receiving…");
    net.sendJson({ t: "tput_down", id, n: 24, size: 65536 });
    const t1 = await done; net.handlers.binary = null;
    if (!t1) return { status: "fail", notes: "timeout" };
    const mbps = (bytes * 8) / (t1 - t0) / 1000;
    return { status: "pass", metrics: { mbps: r3(mbps), bytes, chunks: n, ms: r3(t1 - t0) }, notes: `${mbps.toFixed(2)} Mbit/s` };
  }],
  ["display", "Display: refresh rate & geometry", async () => {
    let f = 0; const t0 = performance.now(); const ts = [];
    await new Promise((res) => { const loop = (t) => { f++; ts.push(t); if (t - t0 < 3000) requestAnimationFrame(loop); else res(); }; requestAnimationFrame(loop); tPrompt("Measuring frame rate (3 s)…"); });
    const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
    return { status: "pass", metrics: { fps: r3(f / 3), frame_ms: stat(dt), screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, depth: screen.colorDepth }, viewport: { w: innerWidth, h: innerHeight },
      hdr: matchMedia("(dynamic-range: high)").matches, gamut_p3: matchMedia("(color-gamut: p3)").matches } };
  }],
  ["tts", "Speaker: speech synthesis", async () => {
    tPrompt("Listen: the glasses should speak");
    const r = await speak("Speaker test. One, two, three.");
    return { status: r.ok ? "pass" : (window.speechSynthesis ? "fail" : "unsupported"), metrics: { start_latency_ms: r3(r.startLatency), duration_ms: r3(r.duration), error: r.error || null, voices: window.speechSynthesis ? speechSynthesis.getVoices().length : 0 } };
  }],
  ["storage", "Storage (local, session, IndexedDB, Cache)", async () => {
    const m = {};
    try { localStorage.setItem("mgt.t", "x".repeat(1024)); m.local = localStorage.getItem("mgt.t").length === 1024; localStorage.removeItem("mgt.t"); } catch (e) { m.local = String(e); }
    try { sessionStorage.setItem("t", "1"); m.session = sessionStorage.getItem("t") === "1"; } catch (e) { m.session = String(e); }
    try { m.idb = await withTimeout(new Promise((res, rej) => { const r = indexedDB.open("mgt-test", 1); r.onsuccess = () => { r.result.close(); res(true); }; r.onerror = () => rej(r.error); }), 3000); } catch (e) { m.idb = String(e); }
    try { const c = await caches.open("mgt-test"); await c.put("/x", new Response("1")); m.cache = !!(await c.match("/x")); await caches.delete("mgt-test"); } catch (e) { m.cache = String(e); }
    try { const e = await navigator.storage.estimate(); m.usage = e.usage; m.quota = e.quota; } catch {}
    return { status: m.local === true ? "pass" : "warn", metrics: m };
  }],
  ["camera_mic", "Camera & microphone (getUserMedia)", async () => {
    if (!navigator.mediaDevices?.getUserMedia) return { status: "unsupported", notes: "Web Apps have no camera/mic; use the Android DAT app" };
    const out = {};
    for (const [k, c] of [["video", { video: true }], ["audio", { audio: true }]]) {
      tPrompt(`Requesting ${k}…`);
      try { const s = await withTimeout(navigator.mediaDevices.getUserMedia(c), 6000, "timeout"); out[k] = s.getTracks().map((t) => t.label || t.kind).join(","); s.getTracks().forEach((t) => t.stop()); }
      catch (e) { out[k] = `${e.name || "Error"}: ${e.message}`; }
    }
    const ok = !/Error|timeout/.test(out.video + out.audio);
    return { status: ok ? "pass" : "unsupported", metrics: out, notes: ok ? "streams available: use Setup → Camera / mic" : "not available in Web Apps runtime" };
  }],
  ["misc_apis", "Wake lock, vibration, Bluetooth, WebRTC…", async () => {
    const m = {};
    try { const l = await navigator.wakeLock.request("screen"); m.wakeLock = "granted"; await l.release(); } catch (e) { m.wakeLock = e.name || String(e); }
    try { m.vibrate = navigator.vibrate ? navigator.vibrate(50) : "unsupported"; } catch (e) { m.vibrate = String(e); }
    try { m.bluetooth = navigator.bluetooth ? await navigator.bluetooth.getAvailability() : "unsupported"; } catch (e) { m.bluetooth = String(e); }
    try { const pc = new RTCPeerConnection(); pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); m.webrtc = "offer ok"; pc.close(); } catch (e) { m.webrtc = e.name || String(e); }
    m.timer_resolution_ms = (() => { let a = performance.now(), b; do { b = performance.now(); } while (b === a); return r3(b - a); })();
    m.hardwareConcurrency = navigator.hardwareConcurrency; m.deviceMemory = navigator.deviceMemory ?? null;
    return { status: "pass", metrics: m };
  }],
  ["nav_input", "Neural Band / touchpad keys", async () => {
    const got = []; const off = bus.on("input", (it) => it.ev === "keydown" && got.push(it.key));
    await countdown(8, "Swipe in any direction or pinch a few times");
    off();
    const keys = [...new Set(got)];
    return { status: got.length ? "pass" : "warn", metrics: { events: got.length, keys }, notes: keys.join(" ") || "no key events" };
  }],
  ["nb_wrist", "Neural Band wrist orientation (emg-wrist)", async () => {
    tPrompt("Looking for the wrist sensor…");
    const st = await wrist.start();
    if (st !== "running") return { status: st === "unavailable" ? "unsupported" : "fail", metrics: { state: st, marker: wrist.marker() }, notes: st };
    const w = collect("nb_wrist");
    await countdown(6, "TWIST your forearm left and right");
    w.stop();
    if (!w.arr.length) return { status: "fail", notes: "no readings (band worn?)", metrics: { state: wrist.state } };
    let prev = null, acc = 0, lo = 0, hi = 0;
    for (const r of w.arr) { if (prev != null) { let d = r.twist - prev; if (d > 180) d -= 360; if (d < -180) d += 360; acc += d; lo = Math.min(lo, acc); hi = Math.max(hi, acc); } prev = r.twist; }
    const span = r3(hi - lo);
    return { status: span > 30 ? "pass" : "warn", metrics: { rate: rateOf(w.arr), twist_span_deg: span, n: w.arr.length }, notes: `${rateOf(w.arr).hz} Hz, twist ${span}°` };
  }],
  ["drag_input", "Pinch-and-drag (pointer events)", async () => ({ status: "skip", notes: "drag mode is per page: open Drag pad" })],
];

function renderList(results, current) {
  $("t-list").innerHTML = TESTS.map(([n], i) => {
    const r = results[n]; const st = r ? r.status : i === current ? "run" : "";
    const g = { pass: "✓", fail: "✗", warn: "!", unsupported: "–", skip: "·", run: "▸" }[st] || " ";
    return `<li class="st-${st}">${g} ${n}${r && r.notes ? " · " + r.notes : ""}</li>`;
  }).join("");
}
async function runSuite(only) {
  if (suite.running) return;
  suite.running = true; suite.abort = false;
  if (ui.screen !== "tests") go("tests");
  const results = {}; const t0 = nowMs();
  const list = only ? TESTS.filter(([n]) => n === only) : TESTS;
  net.sendJson({ t: "test_suite", phase: "start", ts: t0, tests: list.map(([n]) => n) });
  for (const [name, title, fn] of list) {
    if (suite.abort) break;
    const i = TESTS.findIndex(([n]) => n === name);
    $("t-name").textContent = title; $("t-count").textContent = `${i + 1}/${TESTS.length}`;
    renderList(results, i); tPrompt("", 0);
    const ts = nowMs(); let r;
    net.push({ s: "test_mark", ts, name, phase: "start" });
    try { r = await withTimeout(fn(), 60000, "test timeout"); } catch (e) { r = { status: "fail", notes: String(e.message || e) }; }
    r = { name, title, ...r, t_start: ts, t_end: nowMs() };
    results[name] = r;
    net.push({ s: "test_mark", ts: nowMs(), name, phase: "end", status: r.status });
    net.sendJson({ t: "test", ts: nowMs(), ...r });
    renderList(results, i + 1);
  }
  const counts = {}; Object.values(results).forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));
  net.sendJson({ t: "test_suite", phase: "end", ts: nowMs(), dur_ms: nowMs() - t0, counts, aborted: suite.abort });
  tPrompt(suite.abort ? "Aborted" : `Done · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ")}`, 1);
  $("t-name").textContent = "Test suite complete";
  suite.running = false;
}
screens.tests = { enter() { if (!suite.running) runSuite(); }, leave() { suite.abort = true; } };

/* ---------------------------------------------------- Neural Band test */
const NB_KEYS = { ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT", Enter: "SELECT" };
const NB_GLYPH = { UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→", SELECT: "●", DOUBLE: "●●" };
const nb = { running: false, abort: false };
async function runNeural(rounds = 3) {
  if (nb.running) return;
  nb.running = true; nb.abort = false;
  if (ui.screen !== "neural") go("neural");
  const focusEl = $("nb-focus"); focusEl.focus();
  let seq = []; for (let r = 0; r < rounds; r++) seq.push(...["UP", "DOWN", "LEFT", "RIGHT", "SELECT"].sort(() => Math.random() - 0.5));
  seq.push("DOUBLE", "DOUBLE");
  const trials = []; let pending = null;
  const onKey = (e) => {
    const g = NB_KEYS[e.key];
    if (g) { e.preventDefault(); e.stopPropagation(); }
    if (e.repeat) return;
    if (pending) pending({ g: g || "OTHER:" + e.key, ts: evMs(e), via: "keydown" });
  };
  let trialNo = 0;
  const onKeyTs = () => {};
  // Count a pointer click as SELECT only if no Enter follows it (a pinch can send both); keyboard clicks
  // (detail 0) are already counted through keydown.
  const onClick = (e) => {
    e.preventDefault();
    if (e.detail === 0) return;
    const t = nowMs(), ts = evMs(e), at = trialNo;
    setTimeout(() => { if (keyAt.enter < t - 60 && at === trialNo && pending) pending({ g: "SELECT", ts, via: "click" }); }, 180);
  };
  addEventListener("keydown", onKeyTs, true);
  addEventListener("keydown", onKey, true);
  addEventListener("click", onClick, true);
  const fb = $("nb-feedback");
  net.sendJson({ t: "nb_test", phase: "start", ts: nowMs(), n: seq.length });
  for (let i = 0; i < seq.length && !nb.abort; i++) {
    const want = seq[i]; trialNo = i;
    $("nb-step").textContent = `${i + 1} / ${seq.length}`;
    $("nb-arrow").textContent = NB_GLYPH[want];
    $("nb-label").textContent = want === "DOUBLE" ? "PINCH TWICE quickly" : want === "SELECT" ? "PINCH (select)" : `SWIPE ${want}`;
    focusEl.focus();
    const tPrompt0 = nowMs();
    net.push({ s: "nb_prompt", ts: tPrompt0, i, want });
    const events = [];
    await new Promise((res) => {
      const timer = setTimeout(() => { pending = null; res(); }, want === "DOUBLE" ? 5000 : 6000);
      pending = (ev) => {
        events.push(ev);
        if (want !== "DOUBLE" || events.length >= 2) { clearTimeout(timer); pending = null; setTimeout(res, want === "DOUBLE" ? 0 : 250); }
      };
    });
    const first = events[0];
    const tr = { i, want, got: first ? first.g : null, ok: want === "DOUBLE" ? events.length >= 2 && events.every((e) => e.g === "SELECT") : !!first && first.g === want,
      latency_ms: first ? r3(first.ts - tPrompt0) : null, via: first ? first.via : null, extra: events.length - 1,
      double_gap_ms: want === "DOUBLE" && events.length >= 2 ? r3(events[1].ts - events[0].ts) : null };
    trials.push(tr);
    net.push({ s: "nb_trial", ts: nowMs(), ...tr });
    fb.textContent = tr.ok ? `✓ ${tr.got}  ${Math.round(tr.latency_ms)} ms` : `✗ got ${tr.got || "nothing"}`;
    fb.style.color = tr.ok ? "var(--ok)" : "var(--bad)";
    const okN = trials.filter((t) => t.ok).length;
    $("nb-stats").textContent = `accuracy ${okN}/${trials.length}`;
    await sleep(700);
    fb.textContent = "";
  }
  removeEventListener("keydown", onKey, true); removeEventListener("keydown", onKeyTs, true); removeEventListener("click", onClick, true);
  const by = {};
  trials.forEach((t) => { const b = (by[t.want] ||= { n: 0, ok: 0, lat: [], got: {} }); b.n++; if (t.ok) b.ok++; if (t.latency_ms != null) b.lat.push(t.latency_ms); b.got[t.got || "none"] = (b.got[t.got || "none"] || 0) + 1; });
  const summary = Object.fromEntries(Object.entries(by).map(([k, b]) => [k, { n: b.n, ok: b.ok, acc: r3(b.ok / b.n), latency: stat(b.lat), confusion: b.got }]));
  const okN = trials.filter((t) => t.ok).length;
  const lat = stat(trials.filter((t) => t.ok && t.latency_ms != null).map((t) => t.latency_ms));
  net.sendJson({ t: "nb_test", phase: "end", ts: nowMs(), trials, summary, accuracy: r3(okN / Math.max(1, trials.length)), latency: lat, aborted: nb.abort });
  $("nb-arrow").textContent = "✓"; $("nb-label").textContent = `${okN}/${trials.length} correct`;
  $("nb-stats").textContent = `median latency ${lat.p50 ?? "-"} ms · Back to exit`;
  nb.running = false;
}
screens.neural = { enter() { if (!nb.running) runNeural(); }, leave() { nb.abort = true; } };

/* ------------------------------------------------------ remote commands */
async function remote(cmd, a) {
  net.push({ s: "cmd", ts: nowMs(), cmd, args: a });
  switch (cmd) {
    case "run_tests": return runSuite(a.only);
    case "nb_test": return runNeural(a.rounds || 3);
    case "speak": return speak(String(a.text || "hello"));
    case "show": return ui.toast(String(a.text || ""), a.ms || 5000);
    case "marker": return ui.toast("● marker " + (a.label || ""), 1500);
    case "caps": return caps.probe();
    case "home": return history.length > 1 && ui.screen !== "home" ? history.back() : ui.show("home");
    case "screen": return go(a.name || "live");
    case "reload": return location.reload();
    case "pause": net.paused = true; return ui.bar();
    case "resume": net.paused = false; return ui.bar();
    case "media_start": return actions.media($("b-media"));
    case "enable": return actions.enable($("b-enable"));
  }
}

/* -------------------------------------------------------------- boot */
(async function boot() {
  const first = PAGE === "drag" ? "drag" : "home";
  history.replaceState({ screen: first }, "");
  ui.show(first);
  await loadDefaultConfig();
  net.connect();
  startBattery(); startNetInfo();
  caps.probe();
  // motion may already be granted (permission persists); try silently
  if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission !== "function") { startMotion(); }
  wrist.start(); // Generic Sensor permission is already granted on MRBD; harmless if unavailable
  setInterval(() => ui.bar(), 15000);
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};
})();
})();
