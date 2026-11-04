/* Minimal, dependency-free canvas charts for the dashboard.
 * - TimeChart: rolling time-series, 2px lines, recessive grid, legend + direct
 *   end labels, crosshair tooltip on hover.
 * - Pose3D: projected wireframe head/box driven by a quaternion.
 * - Spectrogram: scrolling magnitude spectrum (single-hue sequential ramp).
 */
"use strict";
(function (global) {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, w, h };
  }
  const niceStep = (span, n) => { const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
  const fmt = (v) => (v == null || !isFinite(v) ? "–" : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

  class TimeChart {
    /* opts: {series:[{key,label,color,dash}], windowMs, yMin, yMax, unit, now:()=>ms, getData:()=>[{x,...}]} */
    constructor(el, opts) {
      this.el = el; this.o = Object.assign({ windowMs: 10000, unit: "" }, opts);
      el.classList.add("chart");
      el.innerHTML = `<canvas></canvas><div class="legend"></div><div class="tip" hidden></div>`;
      this.cv = el.querySelector("canvas"); this.tip = el.querySelector(".tip");
      this.hoverX = null;
      el.querySelector(".legend").innerHTML = this.o.series.map((s) => `<span><i style="background:${s.color};${s.dash ? "height:0;border-top:2px dashed " + s.color + ";background:none" : ""}"></i>${s.label}</span>`).join("") + (this.o.unit ? `<span class="unit">${this.o.unit}</span>` : "");
      this.cv.addEventListener("mousemove", (e) => { const r = this.cv.getBoundingClientRect(); this.hoverX = e.clientX - r.left; });
      this.cv.addEventListener("mouseleave", () => { this.hoverX = null; this.tip.hidden = true; });
    }
    draw() {
      const { c, w, h } = fitCanvas(this.cv);
      const pad = { l: 46, r: 64, t: 8, b: 20 };
      const now = this.o.now(), t0 = now - this.o.windowMs;
      const data = this.o.getData().filter((d) => d.x >= t0 - 500);
      c.clearRect(0, 0, w, h);
      let lo = this.o.yMin, hi = this.o.yMax;
      if (lo == null || hi == null) {
        let a = Infinity, b = -Infinity;
        for (const d of data) for (const s of this.o.series) { const v = d[s.key]; if (v != null && isFinite(v)) { a = Math.min(a, v); b = Math.max(b, v); } }
        if (!isFinite(a)) { a = 0; b = 1; }
        if (a === b) { a -= 1; b += 1; }
        const m = (b - a) * 0.08; lo = lo ?? a - m; hi = hi ?? b + m;
      }
      const X = (t) => pad.l + ((t - t0) / this.o.windowMs) * (w - pad.l - pad.r);
      const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
      // grid
      c.font = "11px 'IBM Plex Mono', monospace"; c.fillStyle = css("--text-muted"); c.strokeStyle = css("--grid"); c.lineWidth = 1;
      const st = niceStep(hi - lo, 4);
      for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) { const y = Math.round(Y(v)) + 0.5; c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke(); c.textAlign = "right"; c.fillText(fmt(v), pad.l - 6, y + 4); }
      c.textAlign = "center";
      for (let s = 0; s <= this.o.windowMs / 1000; s += Math.max(1, Math.round(this.o.windowMs / 5000))) { const x = X(now - s * 1000); c.fillText(s ? `-${s}s` : "now", x, h - 5); }
      if (lo < 0 && hi > 0) { c.strokeStyle = css("--axis"); c.beginPath(); c.moveTo(pad.l, Math.round(Y(0)) + 0.5); c.lineTo(w - pad.r, Math.round(Y(0)) + 0.5); c.stroke(); }
      // series
      c.save(); c.beginPath(); c.rect(pad.l, 0, w - pad.l - pad.r, h); c.clip();
      for (const s of this.o.series) {
        c.strokeStyle = s.color; c.lineWidth = 2; c.lineJoin = "round"; c.setLineDash(s.dash ? [5, 4] : []);
        c.beginPath(); let pen = false, lastT = null;
        for (const d of data) {
          const v = d[s.key]; if (v == null || !isFinite(v)) { pen = false; continue; }
          if (lastT != null && d.x - lastT > 1500) pen = false;
          const x = X(d.x), y = Y(Math.max(lo, Math.min(hi, v)));
          pen ? c.lineTo(x, y) : c.moveTo(x, y); pen = true; lastT = d.x;
        }
        c.stroke();
      }
      c.restore(); c.setLineDash([]);
      // direct end labels (text in ink colour, small colour swatch carries identity)
      const last = data[data.length - 1];
      if (last) {
        const labels = this.o.series.map((s) => ({ s, v: last[s.key] })).filter((l) => l.v != null && isFinite(l.v)).map((l) => ({ ...l, y: Y(Math.max(lo, Math.min(hi, l.v))) })).sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
        c.textAlign = "left";
        for (const l of labels) { c.fillStyle = l.s.color; c.fillRect(w - pad.r + 5, l.y - 4, 8, 8); c.fillStyle = css("--text-secondary"); c.fillText(`${l.s.short || l.s.label} ${fmt(l.v)}`, w - pad.r + 16, l.y + 4); }
      }
      // hover crosshair
      if (this.hoverX != null && this.hoverX > pad.l && this.hoverX < w - pad.r && data.length) {
        const t = t0 + ((this.hoverX - pad.l) / (w - pad.l - pad.r)) * this.o.windowMs;
        let best = data[0]; for (const d of data) if (Math.abs(d.x - t) < Math.abs(best.x - t)) best = d;
        const x = X(best.x);
        c.strokeStyle = css("--axis"); c.beginPath(); c.moveTo(x + 0.5, pad.t); c.lineTo(x + 0.5, h - pad.b); c.stroke();
        for (const s of this.o.series) { const v = best[s.key]; if (v == null) continue; c.fillStyle = css("--surface"); c.beginPath(); c.arc(x, Y(v), 5, 0, 7); c.fill(); c.fillStyle = s.color; c.beginPath(); c.arc(x, Y(v), 3.5, 0, 7); c.fill(); }
        this.tip.hidden = false;
        this.tip.innerHTML = `<b>${((best.x - now) / 1000).toFixed(2)} s</b>` + this.o.series.map((s) => `<div><i style="background:${s.color}"></i>${s.label}<span>${fmt(best[s.key])}</span></div>`).join("");
        this.tip.style.left = Math.min(x + 12, w - 150) + "px"; this.tip.style.top = "8px";
      }
    }
  }

  /* quaternion helpers */
  function quatFromEuler(alpha, beta, gamma) { // W3C deviceorientation ZXY intrinsic, degrees
    const d = Math.PI / 180, _x = (beta || 0) * d / 2, _y = (gamma || 0) * d / 2, _z = (alpha || 0) * d / 2;
    const cX = Math.cos(_x), cY = Math.cos(_y), cZ = Math.cos(_z), sX = Math.sin(_x), sY = Math.sin(_y), sZ = Math.sin(_z);
    return { w: cX * cY * cZ - sX * sY * sZ, x: sX * cY * cZ - cX * sY * sZ, y: cX * sY * cZ + sX * cY * sZ, z: cX * cY * sZ + sX * sY * cZ };
  }
  function rotate(q, v) {
    const { w, x, y, z } = q, [vx, vy, vz] = v;
    const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  }

  class Pose3D {
    constructor(cv) { this.cv = cv; this.q = { w: 1, x: 0, y: 0, z: 0 }; }
    set(q) { if (q && isFinite(q.w)) this.q = q; }
    draw(label) {
      const { c, w, h } = fitCanvas(this.cv);
      c.clearRect(0, 0, w, h);
      const s = Math.min(w, h) * 0.28, cx = w / 2, cy = h / 2 + 6;
      const P = (v) => { const r = rotate(this.q, v); const zf = 3 / (3 - r[1] * 0.6); return [cx + r[0] * s * zf, cy - r[2] * s * zf]; }; // view from -Y, z up
      const B = [[-1, -0.7, -0.6], [1, -0.7, -0.6], [1, 0.7, -0.6], [-1, 0.7, -0.6], [-1, -0.7, 0.6], [1, -0.7, 0.6], [1, 0.7, 0.6], [-1, 0.7, 0.6]];
      const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      c.strokeStyle = css("--text-muted"); c.lineWidth = 1.5;
      for (const [a, b] of E) { const p = P(B[a]), q = P(B[b]); c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); }
      const axes = [[[1.5, 0, 0], css("--series-1"), "x"], [[0, 1.5, 0], css("--series-2"), "y"], [[0, 0, 1.5], css("--series-3"), "z"]];
      const o = P([0, 0, 0]);
      c.font = "12px 'IBM Plex Mono', monospace";
      for (const [v, col, n] of axes) { const p = P(v); c.strokeStyle = col; c.lineWidth = 2.5; c.beginPath(); c.moveTo(o[0], o[1]); c.lineTo(p[0], p[1]); c.stroke(); c.fillStyle = css("--text-secondary"); c.fillText(n, p[0] + 4, p[1] - 4); }
      if (label) { c.fillStyle = css("--text-muted"); c.fillText(label, 8, 16); }
    }
  }

  class Spectrogram {
    constructor(cv, n = 512) { this.cv = cv; this.n = n; this.cols = []; this.maxCols = 400; this.buf = []; }
    push(samples, sr) {
      this.sr = sr;
      for (const s of samples) this.buf.push(s);
      while (this.buf.length >= this.n) { this.cols.push(magnitude(this.buf.slice(0, this.n))); this.buf.splice(0, this.n >> 1); if (this.cols.length > this.maxCols) this.cols.shift(); }
    }
    draw() {
      const { c, w, h } = fitCanvas(this.cv);
      c.fillStyle = css("--surface"); c.fillRect(0, 0, w, h);
      if (!this.cols.length) { c.fillStyle = css("--text-muted"); c.font = "12px 'IBM Plex Mono', monospace"; c.fillText("no audio", 10, 20); return; }
      const cw = w / this.maxCols, bins = this.cols[0].length;
      const ramp = (v) => { const t = Math.max(0, Math.min(1, v)); const l = [252, 205, 158, 109, 57, 37, 24, 13]; const a = [252, 226, 197, 167, 135, 106, 79, 54]; const b = [251, 251, 244, 236, 229, 191, 149, 107]; const i = t * 7, k = Math.min(6, Math.floor(i)), f = i - k; return `rgb(${l[k] + (l[k + 1] - l[k]) * f | 0},${a[k] + (a[k + 1] - a[k]) * f | 0},${b[k] + (b[k + 1] - b[k]) * f | 0})`; };
      const off = this.maxCols - this.cols.length;
      for (let i = 0; i < this.cols.length; i++) {
        const col = this.cols[i];
        for (let j = 0; j < bins; j += 2) { const db = 20 * Math.log10(col[j] + 1e-9); c.fillStyle = ramp((db + 90) / 70); c.fillRect((off + i) * cw, h - ((j + 2) / bins) * h, cw + 1, (h / bins) * 2 + 1); }
      }
      c.fillStyle = css("--text-secondary"); c.font = "11px 'IBM Plex Mono', monospace";
      if (this.sr) { c.fillText(`${(this.sr / 2 / 1000).toFixed(0)} kHz`, 4, 12); c.fillText("0", 4, h - 4); }
    }
  }
  function magnitude(x) { // radix-2 FFT with Hann window
    const n = x.length, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
    const out = new Float32Array(n / 2); for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / n; return out;
  }

  global.Charts = { TimeChart, Pose3D, Spectrogram, quatFromEuler, fitCanvas, fmt };
})(window);
