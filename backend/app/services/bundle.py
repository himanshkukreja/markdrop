"""Multi-file HTML bundles — a zip of index.html plus its assets.

A single self-contained HTML file covers most artifacts, but real exports (a
built site, a notebook export, a chart with its own CSS/JS) arrive as a folder.
We accept that as a zip, explode it into R2 under one prefix, and point the
document at the entry HTML. Relative asset paths then resolve for free, because
every file is a sibling at the same prefix — no rewriting, no path mapping.

Extraction is the one place we handle attacker-controlled archive structure, so
it is deliberately paranoid: entry count, per-file size and total uncompressed
size are all capped (zip bombs), and any entry that escapes the prefix via ``..``
or an absolute path is refused outright.
"""

from __future__ import annotations

import posixpath
import zipfile
from io import BytesIO

# Zip-bomb and abuse limits. A 25 MB upload can legitimately expand a lot, but
# not without bound — these caps are what stop a 25 MB zip becoming 10 GB in R2.
MAX_ENTRIES = 500
MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024   # 100 MB across the whole bundle
MAX_ENTRY_BYTES = 25 * 1024 * 1024           # 25 MB for any single file

# Only types we're willing to serve from the artifact origin. Anything else in
# the archive is skipped rather than stored — a bundle is a web page, not a
# general file drop.
_EXT_MIME = {
    "html": "text/html", "htm": "text/html",
    "css": "text/css", "js": "text/javascript", "mjs": "text/javascript",
    "json": "application/json", "map": "application/json",
    "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
    "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    "avif": "image/avif", "ico": "image/x-icon",
    "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf",
    "txt": "text/plain", "csv": "text/csv", "pdf": "application/pdf",
    "md": "text/markdown", "webmanifest": "application/manifest+json",
}


class BundleError(Exception):
    """Raised with a user-facing message when an archive can't be accepted."""


def _safe_member_path(name: str) -> str | None:
    """Normalize a zip entry to a safe relative path, or None to skip it.

    Rejects absolute paths and anything that climbs out of the bundle root —
    without this, an entry like ``../../other-user/index.html`` would let one
    upload overwrite another account's artifact.
    """
    if not name or name.endswith("/"):
        return None
    n = name.replace("\\", "/").lstrip("/")
    if n.startswith("__MACOSX/") or "/." in f"/{n}" and posixpath.basename(n).startswith("."):
        return None
    norm = posixpath.normpath(n)
    if norm.startswith("../") or norm == ".." or posixpath.isabs(norm):
        return None
    return norm


def _strip_common_root(paths: list[str]) -> list[tuple[str, str]]:
    """Map (original -> served) paths, dropping a single wrapping directory.

    Zipping a folder usually yields ``my-site/index.html``; users expect the
    bundle root to be the folder's contents, not the folder itself.
    """
    tops = {p.split("/", 1)[0] for p in paths if "/" in p}
    only_nested = all("/" in p for p in paths)
    if len(tops) == 1 and only_nested:
        root = tops.pop() + "/"
        return [(p, p[len(root):]) for p in paths]
    return [(p, p) for p in paths]


def _pick_entry(served: list[str]) -> str | None:
    """Choose the page to open: root index.html, else the shallowest .html."""
    if "index.html" in served:
        return "index.html"
    htmls = [p for p in served if p.lower().endswith((".html", ".htm"))]
    if not htmls:
        return None
    return min(htmls, key=lambda p: (p.count("/"), len(p)))


def extract(data: bytes) -> tuple[str, list[tuple[str, bytes, str]]]:
    """Validate + unpack a bundle zip.

    Returns ``(entry_path, [(served_path, content, mime), ...])``.
    Raises :class:`BundleError` with a message safe to show the user.
    """
    try:
        zf = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipFile:
        raise BundleError("That file isn't a valid .zip archive.")

    members = [i for i in zf.infolist() if not i.is_dir()]
    if not members:
        raise BundleError("The archive is empty.")
    if len(members) > MAX_ENTRIES:
        raise BundleError(f"Archive has too many files (limit {MAX_ENTRIES}).")

    total = sum(i.file_size for i in members)
    if total > MAX_TOTAL_UNCOMPRESSED:
        raise BundleError(
            f"Archive expands to {total // (1024*1024)} MB — the limit is "
            f"{MAX_TOTAL_UNCOMPRESSED // (1024*1024)} MB."
        )

    safe: list[tuple[str, zipfile.ZipInfo]] = []
    for info in members:
        path = _safe_member_path(info.filename)
        if path is None:
            continue
        if info.file_size > MAX_ENTRY_BYTES:
            raise BundleError(f"'{path}' is larger than {MAX_ENTRY_BYTES // (1024*1024)} MB.")
        safe.append((path, info))

    if not safe:
        raise BundleError("The archive contains no usable files.")

    mapping = dict(_strip_common_root([p for p, _ in safe]))
    served_names = list(mapping.values())
    entry = _pick_entry(served_names)
    if not entry:
        raise BundleError("No .html file found — a bundle needs an index.html.")

    out: list[tuple[str, bytes, str]] = []
    read = 0
    for path, info in safe:
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        mime = _EXT_MIME.get(ext)
        if not mime:
            continue  # skip anything we wouldn't serve
        with zf.open(info) as fh:
            content = fh.read(MAX_ENTRY_BYTES + 1)
        if len(content) > MAX_ENTRY_BYTES:
            raise BundleError(f"'{path}' is larger than {MAX_ENTRY_BYTES // (1024*1024)} MB.")
        read += len(content)
        if read > MAX_TOTAL_UNCOMPRESSED:
            raise BundleError("Archive expands beyond the size limit.")
        out.append((mapping[path], content, mime))

    if not any(p == entry for p, _, _ in out):
        raise BundleError("The entry HTML file could not be read from the archive.")
    return entry, out
