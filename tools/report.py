#!/usr/bin/env python3
"""Build a self-contained HTML report (light theme, serif) for a recorded session.

    python tools/report.py recordings/<session>
"""
from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

S1, S2, S3, NEU = "#2a78d6", "#eb6834", "#1baf7a", "#6f6e68"
plt.rcParams.update({
    "font.family": "serif", "font.serif": ["STIX Two Text", "STIXGeneral", "DejaVu Serif"], "mathtext.fontset": "stix",
    "font.size": 9, "axes.edgecolor": "#b8b7b0", "axes.labelcolor": "#52514e", "xtick.color": "#52514e", "ytick.color": "#52514e",
    "axes.grid": True, "grid.color": "#ecebe6", "grid.linewidth": 0.8, "axes.facecolor": "#fcfcfb", "figure.facecolor": "#fcfcfb",
    "axes.spines.top": False, "axes.spines.right": False, "lines.linewidth": 1.2, "legend.frameon": False,
})

# stream -> list of (title, unit, [(field, label, colour)])
PLOTS = {
    "web.motion": [("Accelerometer incl. gravity", "m/s²", [("ax", "x", S1), ("ay", "y", S2), ("az", "z", S3)]),
                   ("Rotation rate", "°/s", [("ra", "α", S1), ("rb", "β", S2), ("rg", "γ", S3)]),
                   ("Linear acceleration", "m/s²", [("lx", "x", S1), ("ly", "y", S2), ("lz", "z", S3)])],
    "web.orient": [("Orientation", "deg", [("a", "α", S1), ("b", "β", S2), ("g", "γ", S3)])],
    "web.orient_abs": [("Absolute orientation", "deg", [("a", "α", S1), ("b", "β", S2), ("g", "γ", S3)])],
    "web.perf": [("Glasses runtime", "", [("fps", "fps", S1), ("lag", "loop lag ms", S2)])],
    "web.sync": [("Round-trip time", "ms", [("rtt", "rtt", S1)])],
    "web.battery": [("Battery", "level", [("level", "level", S1)])],
    "dat.dat_motion": [("DAT accelerometer", "m/s²", [("ax", "x", S1), ("ay", "y", S2), ("az", "z", S3)]),
                       ("DAT gyroscope", "rad/s", [("gx", "x", S1), ("gy", "y", S2), ("gz", "z", S3)]),
                       ("DAT magnetometer", "µT", [("mx", "x", S1), ("my", "y", S2), ("mz", "z", S3)]),
                       ("DAT orientation quaternion", "", [("qx", "x", S1), ("qy", "y", S2), ("qz", "z", S3), ("qw", "w", NEU)])],
    "dat.dat_audio_level": [("Microphone level", "rms", [("rms", "rms", S1)])],
    "dat.dat_device": [("Glasses battery", "%", [("battery", "battery", S1)])],
}


def load_jsonl(p: Path) -> list[dict]:
    out = []
    with open(p) as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def fig_b64(fig) -> str:
    bio = io.BytesIO()
    fig.savefig(bio, format="png", dpi=130, bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(bio.getvalue()).decode()


def series_plot(rows: list[dict], title: str, unit: str, fields, t0: float) -> str | None:
    t = np.array([r.get("ts", r.get("_rx", 0)) for r in rows], dtype=float)
    if len(t) < 2:
        return None
    fig, ax = plt.subplots(figsize=(7.2, 2.2))
    any_ = False
    for k, lab, c in fields:
        y = np.array([r.get(k) if isinstance(r.get(k), (int, float)) else np.nan for r in rows], dtype=float)
        if np.all(np.isnan(y)):
            continue
        ax.plot((t - t0) / 1000, y, color=c, label=lab)
        any_ = True
    if not any_:
        plt.close(fig)
        return None
    ax.set_title(title, loc="left", fontsize=10)
    ax.set_xlabel("time since session start (s)")
    if unit:
        ax.set_ylabel(unit)
    ax.legend(loc="upper right", ncol=len(fields), fontsize=8)
    return fig_b64(fig)


def stream_stats(rows: list[dict]) -> dict:
    t = np.array([r.get("ts", r.get("_rx")) for r in rows if isinstance(r.get("ts", r.get("_rx")), (int, float))], dtype=float)
    if len(t) < 2:
        return {"n": len(rows)}
    t.sort()
    dt = np.diff(t)
    dur = (t[-1] - t[0]) / 1000
    return {"n": len(rows), "duration_s": round(dur, 2), "rate_hz": round((len(t) - 1) / dur, 2) if dur > 0 else None,
            "dt_ms_p50": round(float(np.median(dt)), 2), "dt_ms_p95": round(float(np.percentile(dt, 95)), 2), "gaps_over_1s": int((dt > 1000).sum())}


def esc(s) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_report(session_dir: Path) -> Path:
    d = Path(session_dir)
    summ = json.loads((d / "session.json").read_text()) if (d / "session.json").exists() else {}
    t0 = summ.get("start_ms") or 0
    streams = {p.stem: p for p in sorted((d / "streams").glob("*.jsonl"))}
    figs, rows_html = [], []
    for key, p in streams.items():
        rows = load_jsonl(p)
        st = stream_stats(rows)
        rows_html.append(f"<tr><td>{esc(key)}</td>" + "".join(f"<td class='n'>{esc(st.get(k, ''))}</td>" for k in ("n", "duration_s", "rate_hz", "dt_ms_p50", "dt_ms_p95", "gaps_over_1s")) + "</tr>")
        groups = {}
        if key == "dat.dat_motion":
            for r in rows:
                groups.setdefault(r.get("src", "GLASSES"), []).append(r)
        else:
            groups[""] = rows
        for gname, grows in groups.items():
            for title, unit, fields in PLOTS.get(key, []):
                b = series_plot(grows, f"{title}{' · ' + gname if gname else ''}", unit, fields, t0)
                if b:
                    figs.append((f"{title} {gname}".strip(), b))
    # tests
    tests_html = []
    for p in sorted(d.glob("*_tests.jsonl")):
        src = p.stem.replace("_tests", "")
        for t in load_jsonl(p):
            if t.get("t") == "test":
                tests_html.append(f"<tr><td>{esc(src)}</td><td>{esc(t.get('title', t.get('name')))}</td><td class='st {esc(t.get('status'))}'>{esc(t.get('status'))}</td>"
                                  f"<td>{esc(t.get('notes', ''))}</td><td><details><summary>metrics</summary><pre>{esc(json.dumps(t.get('metrics'), indent=1))}</pre></details></td></tr>")
            elif t.get("t") == "nb_test" and t.get("phase") == "end":
                tests_html.append(f"<tr><td>{esc(src)}</td><td>Neural Band gesture test</td><td class='st pass'>done</td><td>accuracy {t.get('accuracy')} · latency p50 {(t.get('latency') or {}).get('p50')} ms</td>"
                                  f"<td><details><summary>summary</summary><pre>{esc(json.dumps(t.get('summary'), indent=1))}</pre></details></td></tr>")
    caps_html = []
    for p in sorted(d.glob("*_capabilities.json")):
        c = json.loads(p.read_text()).get("caps", {})
        caps_html.append(f"<h3>{esc(p.stem)}</h3><div class='caps'>" + "".join(
            f"<div class='{'y' if v.get('ok') else 'x'}'>{esc(k)} <span>{esc(v.get('detail') or '')}</span></div>" for k, v in c.items()) + "</div>")
    media = sorted(str(p.relative_to(d)) for p in (d / "media").glob("*") if p.is_file())
    photos = sorted((d / "media").glob("*_photos/*"))[:24]
    photo_html = "".join(f"<img src='data:image/jpeg;base64,{base64.b64encode(p.read_bytes()).decode()}'>" for p in photos if p.suffix in (".jpg", ".jpeg"))
    markers = "".join(f"<li>{(m['rx'] - t0) / 1000:.1f} s · {esc(m['src'])} · {esc(m['label'])}</li>" for m in summ.get("markers", []))
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session {esc(summ.get('name', d.name))}</title>
<link href="https://fonts.googleapis.com/css2?family=STIX+Two+Text:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
<style>
:root{{color-scheme:light}} body{{margin:0 auto;max-width:1000px;padding:24px 16px 60px;background:#fcfcfb;color:#0b0b0b;font:16px/1.5 "STIX Two Text",Georgia,serif}}
h1{{font-size:26px;margin:0}} h2{{font-size:19px;border-bottom:1px solid #dddcd5;padding-bottom:3px;margin-top:30px}} .sub{{color:#52514e;font-style:italic}}
table{{border-collapse:collapse;width:100%;font-size:14px}} th{{text-align:left;border-bottom:1.5px solid #0b0b0b;font-variant:small-caps}} td{{border-bottom:1px solid #ecebe6;padding:3px 6px;vertical-align:top}}
td.n{{text-align:right;font:12.5px "IBM Plex Mono",monospace}} pre{{font:11.5px "IBM Plex Mono",monospace;white-space:pre-wrap;max-height:300px;overflow:auto}}
figure{{margin:14px 0}} figure img{{width:100%}} figcaption{{font-size:13.5px;color:#52514e;font-style:italic}}
.st.pass{{color:#1f7a3a}} .st.fail{{color:#b3261e}} .st.warn{{color:#9a6a00}} .st.unsupported{{color:#85847d}}
.caps{{columns:2;font:12.5px "IBM Plex Mono",monospace}} .caps .y::before{{content:"✓ ";color:#1f7a3a}} .caps .x::before{{content:"✗ ";color:#b3261e}} .caps span{{color:#85847d}}
.photos img{{width:24%;margin:.5%;border:1px solid #ecebe6}} code{{font:13px "IBM Plex Mono",monospace}}
@media (max-width:640px){{.caps{{columns:1}}.photos img{{width:48%}}}}
</style></head><body>
<h1>Sensor session {esc(summ.get('name', d.name))}</h1>
<p class="sub">Duration {summ.get('duration_s', '?')} s · {len(streams)} streams · {summ.get('bytes', 0) / 1048576:.1f} MiB · sources: {esc(', '.join(summ.get('sources', {}).keys()))}</p>
<h2>1 · Streams</h2><table><tr><th>stream</th><th>samples</th><th>duration s</th><th>rate Hz</th><th>Δt p50 ms</th><th>Δt p95 ms</th><th>gaps &gt;1 s</th></tr>{''.join(rows_html)}</table>
<h2>2 · Tests</h2>{'<table><tr><th>source</th><th>test</th><th>status</th><th>notes</th><th></th></tr>' + ''.join(tests_html) + '</table>' if tests_html else '<p class="sub">No tests were run in this session.</p>'}
<h2>3 · Signals</h2>{''.join(f'<figure><img src="data:image/png;base64,{b}"><figcaption>Figure {i + 1}. {esc(t)}.</figcaption></figure>' for i, (t, b) in enumerate(figs)) or '<p class="sub">No plottable streams.</p>'}
<h2>4 · Capabilities</h2>{''.join(caps_html) or '<p class="sub">No capability probe recorded.</p>'}
<h2>5 · Media</h2>{'<ul>' + ''.join(f'<li><code>{esc(m)}</code></li>' for m in media) + '</ul>' if media else '<p class="sub">No media recorded.</p>'}<div class="photos">{photo_html}</div>
<h2>6 · Markers</h2>{'<ul>' + markers + '</ul>' if markers else '<p class="sub">None.</p>'}
</body></html>"""
    out = d / "report.html"
    out.write_text(html)
    return out


if __name__ == "__main__":
    for a in sys.argv[1:]:
        print(build_report(Path(a)))
