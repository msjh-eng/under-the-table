"""Shrink uploaded photos in the built site and strip hidden data (like GPS location).

Runs during publishing. Phone photos are often 3-10 MB; this makes them about 150 KB
so pages load fast, and removes EXIF metadata so no location leaks onto the web.
"""
import sys
from pathlib import Path

from PIL import Image, ImageOps

MAX = 1400
root = Path(sys.argv[1] if len(sys.argv) > 1 else "_site/media")
count = 0
for p in root.rglob("*"):
    if p.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
        continue
    try:
        with Image.open(p) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((MAX, MAX))
            if p.suffix.lower() in {".jpg", ".jpeg"}:
                im = im.convert("RGB")
                im.save(p, "JPEG", quality=80, optimize=True, progressive=True)
            elif p.suffix.lower() == ".png":
                im.save(p, "PNG", optimize=True)
            else:
                im.save(p, "WEBP", quality=80)
        count += 1
    except Exception as e:  # keep publishing even if one photo is odd
        print(f"Skipped {p}: {e}")
print(f"Shrank {count} photo(s)")
