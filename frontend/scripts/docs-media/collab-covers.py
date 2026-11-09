"""The Collaboration overview's card covers (content/docs/collaboration/overview.md): 960x540 crops of the
group M screenshots (shots/m-collab.mjs), light and dark. Run after capturing them, then docs:media-manifest:

    backend/.venv/bin/python frontend/scripts/docs-media/collab-covers.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2] / "public" / "docs-assets" / "collaboration"
SRC = {"comments": "comments/thread", "suggested-edits": "suggested-edits/suggestion", "notifications": "notifications/bell",
       "assign": "assign-and-sign-off/home", "jira": "jira-in-pages/chip-and-card", "insights": "insights-and-exports/insights",
       "settings": "settings-and-privacy/share-switches", "ai": "suggested-edits/summary"}
W, H = 960, 540

for name, base in SRC.items():
    for th in ("", ".dark"):
        im = Image.open(ROOT / f"{base}{th}.webp").convert("RGB")
        h = int(im.width * H / W)
        if im.height > h:  # tall: the top of it
            out = im.crop((0, 0, im.width, h))
        else:  # wide: centred on its own background colour
            out = Image.new("RGB", (im.width, h), im.getpixel((2, 2)))
            out.paste(im, (0, (h - im.height) // 2))
        out.resize((W, H), Image.LANCZOS).save(ROOT / "overview" / f"cover-{name}{th}.webp", "WEBP", quality=82, method=6)
