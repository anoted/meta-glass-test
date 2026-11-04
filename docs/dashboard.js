/* Sensor Suite dashboard: live visualisation + recording control. */
"use strict";
(() => {
const $ = (id) => document.getElementById(id);
const { TimeChart, Pose3D, Spectrogram, quatFromEuler, fmt } = window.Charts;
const C = { s1: "var(--series-1)", s2: "var(--series-2)", s3: "var(--series-3)", s4: "var(--series-4)", n: "var(--neutral)" };
const cssv = (v) => v.startsWith("var(") ? getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() : v;
const col = (k) => cssv(C[k]);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ----------------------------------------------------------- connection */
const qs = new URLSearchParams(location.search);
const ls = { get: (k) => { try { return localStorage.getItem("mgtd." + k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem("mgtd." + k, v); } catch {} } };
if (qs.get("server")) ls.set("server", qs.get("server"));
if (qs.get("key")) ls.set("key", qs.get("key"));
const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const conn = { key: ls.get("key") || "", server: ls.get("server") || "", api: "", ws: null, viewerOffset: 0, links: null };

async function init() {
  if (isLocal) {
    try { const r = await fetch("/api/local"); if (r.ok) { conn.links = await r.json(); conn.key = conn.links.key; } } catch {}
    conn.api = ""; conn.wsBase = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
  } else if (location.hostname.endsWith(".ts.net")) {
    conn.api = ""; conn.wsBase = "wss://" + location.host;
  } else {
    const h = conn.server.replace(/^\w+:\/\//, "").replace(/\/+$/, "");
    conn.api = h ? "https://" + h : ""; conn.wsBase = h ? "wss://" + h : "";
  }
  if (!conn.links && conn.key && conn.wsBase) { try { const r = await fetch(`${conn.api}/api/links?key=${encodeURIComponent(conn.key)}`); if (r.ok) conn.links = await r.json(); } catch {} }
  $("cfg-server").value = conn.server; $("cfg-key").value = conn.key;
  renderSetup();
  connect();
}
function connect() {
  if (!conn.wsBase || !conn.key) { $("conn").textContent = "not configured: open Setup"; return; }
  const ws = new WebSocket(`${conn.wsBase}/ws/view?key=${encodeURIComponent(conn.key)}`);
  ws.binaryType = "arraybuffer"; conn.ws = ws;
  $("conn").textContent = "connecting to " + conn.wsBase;
  ws.onopen = () => { $("conn").textContent = "connected · " + conn.wsBase; };
  ws.onclose = () => { $("conn").textContent = "disconnected, retrying…"; setTimeout(connect, 1500); };
  ws.onmessage = (ev) => (typeof ev.data === "string" ? onJson(JSON.parse(ev.data)) : onBinary(ev.data));
}
const send = (o) => conn.ws && conn.ws.readyState === 1 && conn.ws.send(JSON.stringify(o));
const cmd = (target, c, args = {}) => send({ t: "cmd", target, cmd: c, args });
const serverNow = () => Date.now() + conn.viewerOffset;

/* --------------------------------------------------------------- buffers */
const bufs = new Map();
const offsets = {}; // src -> device→server clock offset (ms)
function buf(key) { let b = bufs.get(key); if (!b) { b = []; bufs.set(key, b); } return b; }
function pushItem(src, it) {
  const key = `${src}.${it.s}`;
  const x = (it.ts ?? it._rx ?? Date.now()) + (offsets[src] || 0);
  const rec = Object.assign({ x }, it);
  const b = buf(key); b.push(rec);
  if (b.length > 8000 || (b.length > 100 && x - b[0].x > 65000)) b.splice(0, Math.max(1, b.length - 6000));
  route(src, rec);
}
const get = (key, filter) => () => { const b = bufs.get(key) || []; return filter ? b.filter(filter) : b; };

/* ---------------------------------------------------------------- charts */
const charts = [];
function tc(el, series, o = {}) { const c = new TimeChart($(el), Object.assign({ series, now: serverNow }, o)); c.tab = $(el).closest(".tab").id; charts.push(c); return c; }
const xyz = (a, b, c2, labels = ["x", "y", "z"]) => [{ key: a, label: labels[0], color: col("s1") }, { key: b, label: labels[1], color: col("s2") }, { key: c2, label: labels[2], color: col("s3") }];
function buildCharts() {
  const wm = get("web.motion");
  tc("w-acc", [...xyz("ax", "ay", "az"), { key: "am", label: "|a|", color: col("n"), dash: true }], { getData: () => wm().map((d) => (d.am === undefined && d.ax != null ? Object.assign(d, { am: Math.hypot(d.ax, d.ay, d.az) }) : d)), unit: "m/s²" });
  tc("w-gyr", xyz("ra", "rb", "rg", ["α", "β", "γ"]), { getData: wm, unit: "°/s" });
  tc("w-lin", xyz("lx", "ly", "lz"), { getData: wm, unit: "m/s²" });
  tc("w-ori", xyz("a", "b", "g", ["α yaw", "β pitch", "γ roll"]), { getData: get("web.orient"), unit: "deg" });
  tc("w-perf", [{ key: "fps", label: "fps", color: col("s1") }, { key: "lag", label: "loop lag ms", color: col("s2") }], { getData: get("web.perf"), windowMs: 60000 });
  tc("w-rtt", [{ key: "rtt", label: "rtt", color: col("s1") }, { key: "best_rtt", label: "best", color: col("n"), dash: true }], { getData: get("web.sync"), windowMs: 120000, unit: "ms" });
  tc("w-alevel", [{ key: "rms", label: "rms", color: col("s1") }], { getData: get("web.audio_level"), windowMs: 20000, yMin: 0 });
  const isG = (d) => d.src !== "NEURAL_BAND", isN = (d) => d.src === "NEURAL_BAND";
  const dm = (f) => get("dat.dat_motion", f);
  tc("d-acc-g", xyz("ax", "ay", "az"), { getData: dm(isG), unit: "m/s²" });
  tc("d-gyr-g", xyz("gx", "gy", "gz"), { getData: dm(isG), unit: "rad/s" });
  tc("d-mag-g", [...xyz("mx", "my", "mz"), { key: "mm", label: "|B|", color: col("n"), dash: true }], { getData: () => dm(isG)().map((d) => (d.mm === undefined && d.mx != null ? Object.assign(d, { mm: Math.hypot(d.mx, d.my, d.mz) }) : d)), unit: "µT" });
  tc("d-quat-g", [{ key: "qw", label: "w", color: col("n"), dash: true }, ...xyz("qx", "qy", "qz")], { getData: dm(isG), yMin: -1, yMax: 1 });
  tc("d-acc-n", xyz("ax", "ay", "az"), { getData: dm(isN), unit: "m/s²" });
  tc("d-gyr-n", xyz("gx", "gy", "gz"), { getData: dm(isN), unit: "rad/s" });
  tc("d-mag-n", [{ key: "qw", label: "w", color: col("n"), dash: true }, ...xyz("qx", "qy", "qz")], { getData: dm(isN), yMin: -1, yMax: 1 });
  tc("d-dt", [{ key: "dtg", label: "glasses", color: col("s1") }, { key: "dtn", label: "Neural Band", color: col("s2") }], { getData: get("dat.dat_motion"), unit: "ms", yMin: 0 });
  tc("d-alevel", [{ key: "rms", label: "rms", color: col("s1") }, { key: "peak", label: "peak", color: col("n"), dash: true }], { getData: get("dat.dat_audio_level"), windowMs: 20000, yMin: 0 });
}
const poses = {};
let spec;

/* ------------------------------------------------------- per-item routing */
const lastTns = {};
const keyCounts = { web: {}, dat: {} };
const dragPts = { web: [], dat: [] };
const tiles = { web: {}, dat: {}, dstate: {} };
function route(src, d) {
  const s = d.s;
  if (src === "web") {
    if (s === "orient") poses.web.set(quatFromEuler(d.a, d.b, d.g)), (poses.webTxt = d);
    else if (s === "orient_abs") poses.webAbs = d;
    else if (s === "geo") geo(d);
    else if (s === "input") webInput(d);
    else if (s === "battery") tiles.web.battery = `${Math.round(d.level * 100)}%${d.charging ? " ⚡" : ""}`;
    else if (s === "net") { tiles.web.network = `${d.type || d.eff || "?"} ${d.down != null ? d.down + "Mb" : ""}`; tiles.web.online = String(d.online); }
    else if (s === "perf") { tiles.web.fps = d.fps; tiles.web.queue = d.q; tiles.web.dropped = d.drop; tiles.web.visibility = d.vis; }
    else if (s === "life") log(src, `lifecycle ${d.ev} (${d.vis})`);
    else if (s === "tts") log(src, `tts ${d.ev}${d.lat != null ? " " + Math.round(d.lat) + "ms" : ""}`);
    else if (s === "perm") log(src, `permissions ${JSON.stringify(d)}`);
    else if (s === "nb_trial") log(src, `neural trial ${d.want} → ${d.got} ${d.ok ? "✓" : "✗"} ${d.latency_ms ?? ""}ms`);
    else if (s.startsWith("gs_")) genericChart(s);
    else if (s === "sync" && d.offset != null) offsets.web = d.offset; // device clock -> server clock
  } else if (src === "dat") {
    if (s === "dat_motion") {
      const k = d.src || "GLASSES";
      if (lastTns[k] != null && d.tns != null) { const dt = (d.tns - lastTns[k]) / 1e6; if (dt > 0 && dt < 2000) d[k === "NEURAL_BAND" ? "dtn" : "dtg"] = dt; }
      lastTns[k] = d.tns;
      if (d.qw != null) (k === "NEURAL_BAND" ? poses.datN : poses.datG).set({ w: d.qw, x: d.qx, y: d.qy, z: d.qz });
    } else if (s === "dat_input") datInput(d);
    else if (s === "dat_device") Object.assign(tiles.dat, { name: d.name, type: d.type, link: d.link, firmware: d.fw, battery: d.battery != null ? d.battery + "%" : "?", charging: d.charging, thermal: d.thermal, worn: d.don, hinge: d.hinge, compatibility: d.compat, display: String(d.display) });
    else if (s === "dat_state") { tiles.dstate[d.cap] = d.state; log(src, `${d.cap} → ${d.state}`); }
    else if (s === "dat_error") { tiles.dstate[d.cap + " error"] = d.error; log(src, `ERROR ${d.cap}: ${d.error}`); }
    else if (s === "dat_speech") speech(d);
    else if (s === "dat_video_stat") $("d-camstat").textContent = `${d.w}×${d.h} · ${fmt(d.fps)} fps · ${fmt(d.kbps)} kbit/s · ${d.frames} frames`;
    else if (s === "phone") Object.assign(tiles.dat, { "phone battery": d.battery + "%" });
    else if (s === "sync" && d.offset != null) offsets.dat = d.offset;
  }
}

const genericMade = new Set();
function genericChart(s) {
  if (genericMade.has(s)) return; genericMade.add(s);
  const div = document.createElement("div"); div.id = "w-" + s; div.className = "ch"; div.style.marginBottom = "10px";
  const h = document.createElement("h3"); h.textContent = s.replace("gs_", "");
  $("w-generic").append(h, div);
  const sample = (bufs.get("web." + s) || [])[0] || {};
  const series = "lux" in sample ? [{ key: "lux", label: "lux", color: col("s1") }] : "qw" in sample ? [{ key: "qw", label: "w", color: col("n"), dash: true }, ...xyz("qx", "qy", "qz")] : "dist" in sample ? [{ key: "dist", label: "cm", color: col("s1") }] : xyz("x", "y", "z");
  tc(div.id, series, { getData: get("web." + s) });
}

/* --------------------------------------------------------------- inputs */
function bars(el, counts) {
  const e = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10); const m = Math.max(1, ...e.map((x) => x[1]));
  $(el).innerHTML = e.map(([k, v]) => `<div class="b"><span>${esc(k)}</span><i style="width:${(v / m) * 100}%"></i><span>${v}</span></div>`).join("");
}
function addLog(el, html, max = 200) { const L = $(el); const d = document.createElement("div"); d.innerHTML = html; L.prepend(d); while (L.childNodes.length > max) L.lastChild.remove(); }
function webInput(d) {
  if (d.ev === "keydown" || d.ev === "click" || d.ev === "popstate" || d.ev === "change" || d.ev === "input") {
    const label = d.ev === "keydown" ? d.key : d.ev === "click" ? "click" : d.ev === "popstate" ? "BACK (popstate)" : `${d.ev} "${d.val ?? ""}"`;
    $("w-last").textContent = label;
    keyCounts.web[label.length > 20 ? d.ev : label] = (keyCounts.web[label.length > 20 ? d.ev : label] || 0) + 1; bars("w-keys", keyCounts.web);
    addLog("w-inlog", `${new Date(d.x).toISOString().slice(11, 23)} ${esc(d.ev)} ${esc(d.key || "")} ${esc(d.tgt || "")} <span class="src">${esc(d.scr || "")}</span>${d.val != null ? " " + esc(JSON.stringify(d.val)) : ""}`);
  }
  if (d.ev && d.ev.startsWith("pointer") && d.x != null && d.ev !== "pointerover" && d.ev !== "pointerout") {
    if (d.ev === "pointerdown") dragPts.web.push(null);
    if (d.ev === "pointermove" || d.ev === "pointerdown") dragPts.web.push([d.x / 600, d.y / 600]);
    if (dragPts.web.length > 4000) dragPts.web.splice(0, 1000);
    if (d.ev !== "pointermove") addLog("w-inlog", `${new Date(d.x).toISOString().slice(11, 23)} ${d.ev} x=${fmt(d.x)} y=${fmt(d.y)} ${esc(d.pt || "")}`);
  }
}
const dragRange = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
function datInput(d) {
  const label = d.type === "nav" ? `NAV ${d.dir}` : d.type === "capture" ? `CAPTURE ${d.press}` : d.type === "button" ? `BUTTON ${d.button}` : d.type === "drag" ? `DRAG ${d.action}` : d.type.toUpperCase();
  if (d.type !== "drag" || d.action !== "MOVE") {
    $("d-last").textContent = label;
    const k = `${label} · ${String(d.src || "").replace("NEURAL_BAND", "NB").replace("CAPTOUCH", "touch").toLowerCase()}`;
    keyCounts.dat[k] = (keyCounts.dat[k] || 0) + 1; bars("d-keys", keyCounts.dat);
    addLog("d-inlog", `${new Date(d.ts).toISOString().slice(11, 23)} ${esc(label)} <span class="src">${esc(d.src)} t=${d.tms}</span>`);
  }
  if (d.type === "drag") {
    if (d.action === "DOWN") dragPts.dat.push(null);
    dragPts.dat.push([d.x, d.y]);
    dragRange.x0 = Math.min(dragRange.x0, d.x); dragRange.x1 = Math.max(dragRange.x1, d.x); dragRange.y0 = Math.min(dragRange.y0, d.y); dragRange.y1 = Math.max(dragRange.y1, d.y);
    if (dragPts.dat.length > 4000) dragPts.dat.splice(0, 1000);
  }
}
function drawDrag(el, pts, norm) {
  const { c, w, h } = window.Charts.fitCanvas($(el));
  c.clearRect(0, 0, w, h);
  c.strokeStyle = col("s1"); c.lineWidth = 2; c.beginPath(); let pen = false;
  const sx = norm ? (v) => (v - dragRange.x0) / (dragRange.x1 - dragRange.x0 || 1) : (v) => v;
  const sy = norm ? (v) => (v - dragRange.y0) / (dragRange.y1 - dragRange.y0 || 1) : (v) => v;
  for (const p of pts) { if (!p) { pen = false; continue; } const x = 8 + sx(p[0]) * (w - 16), y = 8 + sy(p[1]) * (h - 16); pen ? c.lineTo(x, y) : c.moveTo(x, y); pen = true; }
  c.stroke();
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted"); c.font = "11px 'IBM Plex Mono', monospace";
  c.fillText(norm ? `x ${fmt(dragRange.x0)}…${fmt(dragRange.x1)}  y ${fmt(dragRange.y0)}…${fmt(dragRange.y1)}` : "0…600 px", 8, h - 6);
}

/* ------------------------------------------------------------- location */
let map, marker, accCircle, trail;
function geo(d) {
  $("w-geo").textContent = `${d.lat.toFixed(6)}, ${d.lon.toFixed(6)} ± ${Math.round(d.acc)} m · alt ${d.alt ?? "–"} · speed ${d.spd ?? "–"} · heading ${d.hdg ?? "–"}`;
  if (!window.L) return;
  if (!map) {
    map = L.map("w-map", { attributionControl: true }).setView([d.lat, d.lon], 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    marker = L.circleMarker([d.lat, d.lon], { radius: 6, color: col("s1"), weight: 2, fillOpacity: 0.8 }).addTo(map);
    accCircle = L.circle([d.lat, d.lon], { radius: d.acc, color: col("s1"), weight: 1, fillOpacity: 0.08 }).addTo(map);
    trail = L.polyline([], { color: col("s2"), weight: 2 }).addTo(map);
  }
  marker.setLatLng([d.lat, d.lon]); accCircle.setLatLng([d.lat, d.lon]).setRadius(d.acc); trail.addLatLng([d.lat, d.lon]);
}

/* ---------------------------------------------------------------- speech */
let partialEl = null;
function speech(d) {
  if (!partialEl) { partialEl = document.createElement("div"); partialEl.className = "partial"; $("d-speech").prepend(partialEl); }
  partialEl.textContent = d.text;
  if (d.final) { partialEl.className = ""; partialEl.textContent = `${new Date(d.ts).toTimeString().slice(0, 8)}  ${d.text}  (${d.conf >= 0 ? d.conf.toFixed(2) : "–"})`; partialEl = null; }
}

/* ----------------------------------------------------------------- media */
let audioCtx = null, audioNext = 0;
const camStat = { web: { n: 0 }, dat: { n: 0 } };
function onBinary(ab) {
  const dv = new DataView(ab); const kind = dv.getUint8(0), ts = dv.getFloat64(1), ml = dv.getUint16(9);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 11, ml)) || "{}");
  const payload = new Uint8Array(ab, 11 + ml);
  if (kind === 3) {
    const img = meta.src === "web" ? $("w-cam") : $("d-cam");
    const url = URL.createObjectURL(new Blob([payload], { type: "image/jpeg" }));
    img.onload = () => URL.revokeObjectURL(url); img.src = url;
  } else if (kind === 4) {
    const im = document.createElement("img"); im.src = URL.createObjectURL(new Blob([payload], { type: "image/" + (meta.ext === "png" ? "png" : "jpeg") })); im.title = new Date(ts).toISOString();
    $("d-photos").prepend(im); while ($("d-photos").children.length > 24) $("d-photos").lastChild.remove();
  } else if (kind === 2) {
    const sr = meta.sr || 16000, ch = meta.ch || 1;
    const i16 = new Int16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + (payload.byteLength & ~1)));
    const mono = new Float32Array(Math.floor(i16.length / ch)); for (let i = 0; i < mono.length; i++) mono[i] = i16[i * ch] / 32768;
    spec.push(mono, sr);
    if ($("listen").checked) {
      if (!audioCtx) { audioCtx = new AudioContext(); audioNext = 0; }
      const b = audioCtx.createBuffer(1, mono.length, sr); b.copyToChannel(mono, 0);
      const n = audioCtx.createBufferSource(); n.buffer = b; n.connect(audioCtx.destination);
      if (audioNext < audioCtx.currentTime + 0.05 || audioNext > audioCtx.currentTime + 1.0) audioNext = audioCtx.currentTime + 0.15;
      n.start(audioNext); audioNext += b.duration;
    }
  }
}

/* ------------------------------------------------------------ JSON msgs */
const latest = { tests: {}, nb: null, caps: {} };
function onJson(m) {
  const src = m._src;
  switch (m.t) {
    case "view_hello":
      Object.entries(m.latest || {}).forEach(([s, v]) => { if (v.caps) renderCaps(s, v.caps); (v.tests || []).forEach((t) => onTest(s, t)); });
      (m.logs || []).forEach((l) => log(l.src, `${l.level || "log"}: ${l.msg}`));
      onStats(m.status); break;
    case "stats": onStats(m); break;
    case "batch": (m.items || []).forEach((it) => pushItem(src, it)); break;
    case "hello": log(src, `hello ${m.app} v${m.ver} ${m.info ? (m.info.ua || m.info.model || "") : ""}`); helloInfo[src] = m; break;
    case "caps": renderCaps(src, m); break;
    case "test": onTest(src, m); break;
    case "test_suite": log(src, `test suite ${m.phase}${m.counts ? " " + JSON.stringify(m.counts) : ""}`); break;
    case "nb_test": if (m.phase === "end") renderNB(m); log(src, `neural band test ${m.phase}${m.accuracy != null ? " accuracy " + m.accuracy : ""}`); break;
    case "dat_state": datSnapshot(m); break;
    case "log": log(src, `${m.level || "log"}: ${m.msg}`); break;
    case "marker": log(src || "viewer", `● marker ${m.label}`); break;
    case "source_up": log(m.src, `connected from ${m.peer}`); break;
    case "source_down": log(m.src, "disconnected"); break;
    case "session_closed": log("server", `session ${m.name} closed, finalizing…`); break;
    case "session_finalized": log("server", `session ${m.name} finalized (CSV, MP4, report)`); loadSessions(); break;
  }
}
const helloInfo = {};
function datSnapshot(m) {
  if (m.device) route("dat", Object.assign({ s: "dat_device", ts: m.ts }, m.device));
  Object.assign(tiles.dstate, m.states || {});
}
let lastStats = null;
function onStats(st) {
  if (!st) return; lastStats = st;
  if (st.now) conn.viewerOffset = st.now - Date.now();
  const ses = st.session;
  $("rec-dot").className = "recdot" + (st.recording && ses ? " on" : "");
  $("rec-name").textContent = ses ? `${ses.name} · ${fmtDur(ses.duration_s)} · ${fmtBytes(ses.bytes)}` : st.recording ? "armed: records when a source connects" : "not recording";
  $("b-rec").textContent = st.recording ? "Stop recording" : "Start recording";
  const srcs = st.sources || [];
  $("src-cards").innerHTML = ["web", "dat"].map((name) => {
    const s = srcs.find((x) => x.src === name);
    const title = name === "web" ? "Glasses Web App" : "DAT companion (phone)";
    if (!s) return `<div class="card"><h2>${title}<span class="status down">offline</span></h2><p class="cap">${name === "web" ? "Open Sensor Suite on the glasses." : "Start the Android app and a session."}</p></div>`;
    const tot = Object.values(s.rates || {}).reduce((a, b) => a + b, 0);
    return `<div class="card"><h2>${title}<span class="status up">live</span></h2><div class="kv">
      <span>app</span><span>${esc(s.app || "?")} ${esc(s.ver || "")}</span><span>peer</span><span>${esc(s.peer)}</span>
      <span>connected</span><span>${fmtDur((Date.now() + conn.viewerOffset - s.connected_ms) / 1000)}</span>
      <span>samples/s</span><span>${tot}</span><span>bytes/s</span><span>${fmtBytes(s.bytes_rate)}</span>
      <span>messages</span><span>${s.msgs}</span><span>rtt / offset</span><span>${s.sync ? `${fmt(s.sync.rtt)} ms / ${fmt(s.sync.offset)} ms` : "–"}</span></div></div>`;
  }).join("") + srcs.filter((s) => s.src !== "web" && s.src !== "dat").map((s) => `<div class="card"><h2>${esc(s.src)}<span class="status up">live</span></h2><div class="kv"><span>messages</span><span>${s.msgs}</span></div></div>`).join("");
  $("rates-tbl").querySelector("tbody").innerHTML = srcs.flatMap((s) => Object.keys(s.items || {}).sort().map((k) => `<tr><td>${esc(s.src)}</td><td class="mono">${esc(k)}</td><td class="num">${s.rates[k] ?? 0}</td><td class="num">${s.items[k]}</td></tr>`)).join("") || `<tr><td colspan="4" class="cap">No sources connected.</td></tr>`;
  $("setup-conn").textContent = `viewer ws: ${conn.wsBase}\nviewers: ${st.viewers}\nsources: ${srcs.map((s) => s.src).join(", ") || "none"}\nfinalizing: ${(st.finalizing || []).join(", ") || "–"}`;
}
const fmtDur = (s) => (s == null ? "–" : s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${Math.floor(s / 60)} m ${Math.floor(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`);
const fmtBytes = (b) => (b == null ? "–" : b < 1024 ? `${b.toFixed ? b.toFixed(0) : b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KiB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MiB` : `${(b / 1073741824).toFixed(2)} GiB`);

function log(src, text) { addLog("log", `${new Date().toTimeString().slice(0, 8)} <span class="src">[${esc(src)}]</span> ${esc(text)}`, 400); }

/* ----------------------------------------------------------------- tests */
function onTest(src, t) {
  latest.tests[`${src}:${t.name}`] = Object.assign({ _src: src }, t);
  const rows = Object.values(latest.tests).sort((a, b) => (a._src + a.t_start).localeCompare(b._src + b.t_start));
  $("tests-tbl").querySelector("tbody").innerHTML = rows.map((r) => `<tr data-k="${esc(r._src + ":" + r.name)}"><td>${esc(r._src)}</td><td>${esc(r.title || r.name)}</td><td><span class="st ${esc(r.status)}">${{ pass: "✓ pass", fail: "✗ fail", warn: "! warn", unsupported: "– n/a", skip: "· skip", manual: "· manual" }[r.status] || esc(r.status)}</span></td><td class="small">${esc(r.notes || "")}</td><td class="num">${r.t_end && r.t_start ? ((r.t_end - r.t_start) / 1000).toFixed(1) + " s" : ""}</td></tr>`).join("");
}
$("tests-tbl").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-k]"); if (tr) $("test-detail").textContent = JSON.stringify(latest.tests[tr.dataset.k], null, 2); });
function renderCaps(src, m) {
  const c = m.caps || {}; latest.caps[src] = c;
  $("caps").innerHTML = `<p class="cap">${esc(src)}: ${Object.values(c).filter((v) => v.ok).length} of ${Object.keys(c).length} available</p>` +
    Object.entries(c).map(([k, v]) => `<div class="${v.ok ? "y" : "n"}">${esc(k)}${v.detail != null ? ` <span class="d">${esc(String(v.detail).slice(0, 70))}</span>` : ""}</div>`).join("");
}
function renderNB(m) {
  latest.nb = m;
  const G = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"];
  const got = new Set(); (m.trials || []).forEach((t) => got.add(t.got || "none"));
  const cols = [...G, ...[...got].filter((g) => !G.includes(g))];
  const cm = G.map((w) => `<tr><th>${w}</th>${cols.map((g) => `<td>${(m.trials || []).filter((t) => t.want === w && (t.got || "none") === g).length || ""}</td>`).join("")}</tr>`).join("");
  const lat = m.latency || {};
  $("nb-summary").innerHTML = `<div class="tiles"><div class="tile"><div class="k">accuracy</div><div class="v">${(m.accuracy * 100).toFixed(0)}%</div></div>
    <div class="tile"><div class="k">latency p50</div><div class="v">${fmt(lat.p50)} ms</div></div><div class="tile"><div class="k">latency p95</div><div class="v">${fmt(lat.p95)} ms</div></div>
    <div class="tile"><div class="k">double-pinch gap</div><div class="v">${fmt(((m.trials || []).find((t) => t.double_gap_ms) || {}).double_gap_ms)} ms</div></div></div>
    <table class="cm"><tr><th>prompt ↓ / received →</th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${cm}</table>`;
}

/* ------------------------------------------------------------ recordings */
async function loadSessions() {
  if (!conn.key) return;
  try {
    const r = await fetch(`${conn.api}/api/sessions?key=${encodeURIComponent(conn.key)}`); const list = await r.json();
    const u = (n, p) => `${conn.api}/api/sessions/${encodeURIComponent(n)}/${p.split("/").map(encodeURIComponent).join("/")}?key=${encodeURIComponent(conn.key)}`;
    $("sessions").innerHTML = list.map((s) => `<details class="sess"><summary><b>${esc(s.name)}</b> · ${fmtDur(s.duration_s)} · ${fmtBytes(s.bytes)} ${s.closed ? "" : "<span class='status up'>recording</span>"} ${s.finalizing ? "· finalizing…" : ""}
      ${s.has_report ? ` · <a href="${u(s.name, "report.html")}" target="_blank" rel="noopener">report</a>` : ""} ${s.closed ? `· <button data-fin="${esc(s.name)}">re-finalize</button>` : ""}</summary>
      <p class="small">${Object.entries(s.counts || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ")}</p>
      <div class="files">${s.files.map((f) => `<div><a href="${u(s.name, f)}" target="_blank" rel="noopener">${esc(f)}</a></div>`).join("")}</div></details>`).join("") || "<p class='cap'>No sessions yet.</p>";
  } catch (e) { $("sessions").textContent = "Could not load sessions: " + e; }
}
$("sessions").addEventListener("click", async (e) => { const b = e.target.closest("[data-fin]"); if (!b) return; e.preventDefault(); b.textContent = "…"; await fetch(`${conn.api}/api/sessions/${encodeURIComponent(b.dataset.fin)}/finalize?key=${encodeURIComponent(conn.key)}`, { method: "POST" }); loadSessions(); });

/* ----------------------------------------------------------------- setup */
function renderSetup() {
  const L = conn.links || {};
  $("l-glasses").textContent = L.glasses_url || "(start the server with Tailscale to get a public URL)";
  $("l-android").textContent = L.android_config_link || "–";
  $("l-ingest").textContent = L.ingest_url ? `${L.ingest_url}  key=${L.key}` : "–";
  $("l-remote").textContent = L.remote_dashboard_url || "–";
  const qr = (data) => `${conn.api}/api/qr.svg?key=${encodeURIComponent(conn.key)}&data=${encodeURIComponent(data)}`;
  if (L.glasses_deeplink) $("qr-glasses").src = qr(L.glasses_deeplink);
  if (L.android_config_link) $("qr-android").src = qr(L.android_config_link);
}

/* --------------------------------------------------------------- tiles */
function renderTiles(el, obj) { $(el).innerHTML = Object.entries(obj).map(([k, v]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v ?? "–")}</div></div>`).join("") || "<p class='cap'>No data yet.</p>"; }

/* ------------------------------------------------------------ draw loop */
let activeTab = "t-overview";
function frame() {
  for (const c of charts) if (c.tab === activeTab) c.draw();
  if (activeTab === "t-web") {
    const o = poses.webTxt, a = poses.webAbs;
    poses.web.draw("deviceorientation");
    $("w-pose-txt").textContent = o ? `α ${fmt(o.a)}°\nβ ${fmt(o.b)}°\nγ ${fmt(o.g)}°\nabsolute ${o.abs}\n${a ? `abs α ${fmt(a.a)}°` : "no absolute stream"}` : "no orientation yet";
    drawDrag("w-drag", dragPts.web, false);
  } else if (activeTab === "t-dat") {
    poses.datG.draw("glasses"); poses.datN.draw("Neural Band");
    drawDrag("d-drag", dragPts.dat, true); spec.draw();
  }
  requestAnimationFrame(frame);
}
setInterval(() => {
  renderTiles("w-tiles", tiles.web); renderTiles("d-tiles", tiles.dat); renderTiles("d-states", tiles.dstate);
  if (helloInfo.web && helloInfo.web.info) tiles.web.viewport = `${helloInfo.web.info.viewport.w}×${helloInfo.web.info.viewport.h}`;
}, 1000);

/* ---------------------------------------------------------------- wiring */
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === "t-" + b.dataset.tab));
  activeTab = "t-" + b.dataset.tab;
  if (b.dataset.tab === "recordings") loadSessions();
  if (b.dataset.tab === "web" && map) setTimeout(() => map.invalidateSize(), 50);
}));
document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => { const [t, c] = b.dataset.cmd.split(":"); cmd(t, c, b.dataset.args ? JSON.parse(b.dataset.args) : {}); log("viewer", `→ ${t} ${c}`); }));
$("b-say").onclick = () => cmd("web", "speak", { text: $("say-in").value || "Hello from the recorder" });
$("b-show").onclick = () => cmd("web", "show", { text: $("say-in").value || "Hello" });
$("b-rate").onclick = () => cmd("dat", "motion", { on: true, rate: +$("motion-rate").value });
$("b-marker").onclick = () => { send({ t: "srv", op: "marker", label: $("marker-in").value || "mark" }); $("marker-in").value = ""; };
$("marker-in").addEventListener("keydown", (e) => e.key === "Enter" && $("b-marker").click());
$("b-newses").onclick = () => send({ t: "srv", op: "new_session" });
$("b-rec").onclick = () => send({ t: "srv", op: lastStats && lastStats.recording ? "stop_rec" : "start_rec" });
$("b-refresh").onclick = loadSessions;
$("b-cfg").onclick = () => { ls.set("server", $("cfg-server").value.trim()); ls.set("key", $("cfg-key").value.trim()); location.search = ""; };

poses.web = new Pose3D($("w-pose")); poses.datG = new Pose3D($("d-pose-g")); poses.datN = new Pose3D($("d-pose-n"));
spec = new Spectrogram($("d-spec"));
buildCharts();
requestAnimationFrame(frame);
init();
})();
