"""Generate the Web App icons (PNG; the glasses runtime does not accept SVG)."""
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parent.parent / "docs"
for size in (192, 512):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    d = ImageDraw.Draw(im)
    s = size / 192
    # waveform: three sensor traces in the dashboard's series colours
    for k, (col, amp, ph) in enumerate([((70, 215, 255), 22, 0), ((255, 154, 74), 16, 1.3), ((109, 255, 176), 12, 2.4)]):
        import math
        pts = [(x * s, (96 + (k - 1) * 34 + amp * math.sin(x / 14 + ph)) * s) for x in range(24, 169, 2)]
        d.line(pts, fill=col, width=max(2, int(7 * s)), joint="curve")
    d.rounded_rectangle([10 * s, 10 * s, 182 * s, 182 * s], radius=34 * s, outline=(244, 244, 240), width=max(2, int(6 * s)))
    im.save(out / f"icon-{size}.png")
print("ok")
