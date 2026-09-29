"""Turns the rendered mark into the icon files Windows needs.

Writes a multi-size .ico (the sizes Explorer, the taskbar and the installer pick from) and a 256px
.png for anything that wants a raster mark. The tray sizes are written by scripts/make-icon.cjs,
which draws them from the simplified variant. Run after make-icon.cjs.

Needs Pillow; on this machine use the Hermes venv python.
"""

import os
import sys

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FULL = os.path.join(REPO, "build", "icon-full-512.png")
SMALL = os.path.join(REPO, "build", "icon-small-256.png")
ICO = os.path.join(REPO, "build", "icon.ico")
PNG = os.path.join(REPO, "build", "icon.png")

# which drawing each size gets
FULL_SIZES = [256, 128, 64, 48]
SMALL_SIZES = [32, 24, 16]

full = Image.open(FULL).convert("RGBA")
small = Image.open(SMALL).convert("RGBA")
print(f"full source: {full.size[0]}px   small source: {small.size[0]}px")

# LANCZOS keeps the rounded tile's edge and the stroke clean; a boxier filter turns the brain into
# a blob exactly where it matters least to lose detail and most to notice.
frames = [(s, full.resize((s, s), Image.LANCZOS)) for s in FULL_SIZES]
frames += [(s, small.resize((s, s), Image.LANCZOS)) for s in SMALL_SIZES]
frames.sort(key=lambda pair: pair[0], reverse=True)
images = [f for _, f in frames]

# Pillow packs a real multi-size .ico from a list of frames; sizes= must match the frame list or it
# silently writes only the first one.
images[0].save(
    ICO,
    format="ICO",
    sizes=[(f.width, f.height) for f in images],
    append_images=images[1:],
)
print(f"wrote {ICO}  {os.path.getsize(ICO)} bytes")
print(f"   sizes: {[s for s, _ in frames]}  (full drawing for >=48, simplified below)")

full.resize((256, 256), Image.LANCZOS).save(PNG, format="PNG")
print(f"wrote {PNG}  {os.path.getsize(PNG)} bytes")

# The tray asks for a 16px and a 32px (the latter for 200% displays), both from the simplified
# drawing — the full one is not legible that small.
TRAY = os.path.join(REPO, "electron", "assets", "tray.png")
TRAY_1X = os.path.join(REPO, "electron", "assets", "tray@1x.png")
small.resize((16, 16), Image.LANCZOS).save(TRAY, format="PNG")
small.resize((32, 32), Image.LANCZOS).save(TRAY_1X, format="PNG")
print(f"wrote {TRAY} (16px) and {TRAY_1X} (32px), from the simplified drawing")

# verify what actually landed in the ico, rather than trusting the call
with Image.open(ICO) as check:
    seen = sorted(check.ico.sizes()) if hasattr(check, "ico") else []
print(f"ico contains: {seen}")
if len(seen) < 5:
    print("WARNING: the ico looks like it carries fewer sizes than expected", file=sys.stderr)
