"""Workspace branding assets — uploaded favicons and logos.

Artifacts stream straight from the browser to R2 with a presigned PUT, and the
server never sees the bytes. Branding assets deliberately do the opposite: they
go through this process so that every one of them can be decoded and re-encoded
before it is stored.

That re-encode is the whole security control. These images are served from a
stable public URL and embedded in `<link rel="icon">` and in preview cards, so an
attacker who can put arbitrary bytes at that URL has a hosted-content primitive:
an HTML/GIF polyglot, an SVG carrying script, a JPEG with an EXIF payload. Pillow
opening the file and writing a fresh PNG discards all of it -- what lands in R2 is
pixels this process produced, not bytes anyone uploaded.

Bytes pass through a 2 vCPU box here, which is fine at these sizes and is why the
ceiling below is small.
"""

from __future__ import annotations

import hashlib
import io

from fastapi import HTTPException

from app.config import get_settings

settings = get_settings()

# Generous for a logo, tiny next to an artifact. The decoded-pixel guard below
# matters more than this: a few KB of PNG can claim to be 40000x40000.
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_PIXELS = 40_000_000

# (longest edge, whether transparency is kept). A favicon is displayed at 16-32
# CSS pixels; 128 covers retina and every "large icon" surface without storing a
# wallpaper. Logos appear on preview cards at a few hundred pixels wide.
_SPECS = {
    "favicon": (128, True),
    "logo": (512, True),
}


def public_url(key: str) -> str:
    """Where the browser will fetch this asset from.

    The artifact origin, not the API host: it is already the edge-cached,
    cookie-less, session-free domain that exists precisely to serve bytes users
    supplied. A branding image is exactly that.
    """
    return f"{settings.artifact_origin.rstrip('/')}/b/{key}"


def process(raw: bytes, kind: str) -> tuple[bytes, str]:
    """Decode, normalise and re-encode. Returns (png_bytes, r2_key_suffix).

    Raises HTTPException on anything that isn't an image we can safely rewrite.
    """
    if kind not in _SPECS:
        raise HTTPException(status_code=422, detail="Unknown branding asset.")
    if not raw:
        raise HTTPException(status_code=422, detail="That file is empty.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Images must be under {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
        )

    from PIL import Image

    longest, keep_alpha = _SPECS[kind]

    try:
        # verify() on a throwaway handle first: it checks structural integrity
        # without decoding pixels, so a malformed file is rejected cheaply.
        Image.open(io.BytesIO(raw)).verify()
        img = Image.open(io.BytesIO(raw))
        # A decompression bomb is a small file that decodes to enormous pixels.
        # Checking the declared size before load() means we never allocate it.
        w, h = img.size
        if w * h > MAX_PIXELS or w < 1 or h < 1:
            raise HTTPException(status_code=422, detail="That image is too large to process.")
        img.load()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=422,
            detail="That doesn't look like an image we can read. Try a PNG, JPEG, WebP or GIF.",
        )

    # Animated sources collapse to their first frame -- an animated favicon is a
    # nuisance, and re-encoding is the point.
    if getattr(img, "is_animated", False):
        img.seek(0)

    img = img.convert("RGBA" if keep_alpha else "RGB")
    if max(img.size) > longest:
        img.thumbnail((longest, longest), Image.LANCZOS)

    out = io.BytesIO()
    # No EXIF, no ICC, no ancillary chunks are carried across: this is a fresh
    # file built from the decoded pixel buffer alone.
    img.save(out, format="PNG", optimize=True)
    data = out.getvalue()

    # Content-addressed, so replacing a logo publishes a new URL and no cache --
    # browser, Cloudflare or Slack's card scraper -- can serve the old one.
    digest = hashlib.sha256(data).hexdigest()[:16]
    return data, f"{kind}-{digest}.png"
