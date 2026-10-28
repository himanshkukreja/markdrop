"""Media metadata and video posters, with ffprobe and ffmpeg.

Best effort throughout: a missing binary, a timeout or a file ffmpeg can't
read leaves ``media`` null and no poster, and never fails an upload. There is
no transcoding; the original bytes are what viewers get.

The file is never downloaded. ffprobe and ffmpeg read it through a short-lived
presigned GET URL and fetch only what they need with range requests (the
header, and the frames around the poster's timestamp).

Hardening, because the bytes are a stranger's: the demuxer is pinned from the
artifact's MIME type (``-f mov`` for an .mp4, never auto-detected), so a file
that is really an HLS playlist or a concat script can't make ffmpeg open other
URLs or local files; and ``-protocol_whitelist`` allows only the network
protocols the presigned URL needs.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from typing import Any

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

PROBE_TIMEOUT_S = 60
POSTER_TIMEOUT_S = 90
POSTER_MAX_WIDTH = 1280
POSTER_MAX_BYTES = 5 * 1024 * 1024

# Demuxer per MIME type. Anything not listed isn't probed.
DEMUXERS = {
    "video/mp4": "mov",
    "video/quicktime": "mov",
    "video/webm": "matroska",
    "video/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "mov",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
}
_NET_PROTOCOLS = "https,tls,tcp,http,crypto"


def binary(name: str) -> str | None:
    """Path to ffprobe/ffmpeg: the configured one, else whatever is on PATH."""
    configured = settings.ffprobe_path if name == "ffprobe" else settings.ffmpeg_path
    if configured:
        return configured if shutil.which(configured) else None
    return shutil.which(name)


def _input_args(source: str, mime: str) -> list[str] | None:
    fmt = DEMUXERS.get((mime or "").lower())
    if fmt is None:
        return None
    local = "://" not in source
    return [
        "-protocol_whitelist", "file" if local else _NET_PROTOCOLS,
        "-f", fmt,
        *([] if local else ["-rw_timeout", "20000000"]),  # µs: a stalled read gives up
        "-i", source,
    ]


async def _run(args: list[str], timeout: float) -> tuple[int, bytes, bytes] | None:
    """Run a binary with no shell. None on timeout or when it can't start."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except (OSError, ValueError):
        return None
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()
        return None
    return proc.returncode or 0, out, err


def _num(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _rotation(stream: dict) -> int:
    for sd in stream.get("side_data_list") or []:
        r = _num(sd.get("rotation"))
        if r is not None:
            return int(round(r)) % 360
    r = _num((stream.get("tags") or {}).get("rotate"))
    return int(round(r)) % 360 if r is not None else 0


def parse_probe(data: dict) -> dict | None:
    """ffprobe's JSON (-show_format -show_streams) → our ``media`` dict:
    {duration_s, width, height, video_codec, audio_codec}. Width and height
    are as displayed (a phone video recorded in portrait reports portrait).
    None when there's neither a video nor an audio stream."""
    if not isinstance(data, dict):
        return None
    streams = [s for s in data.get("streams") or [] if isinstance(s, dict)]
    # Cover art in an mp3 or m4a is a "video" stream; it isn't the content.
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None and audio is None:
        return None
    duration = _num((data.get("format") or {}).get("duration"))
    if duration is None:
        duration = next((d for d in (_num(s.get("duration")) for s in (video, audio) if s) if d), None)
    width = height = None
    if video is not None:
        width, height = video.get("width"), video.get("height")
        if isinstance(width, int) and isinstance(height, int) and _rotation(video) in (90, 270):
            width, height = height, width
    return {
        "duration_s": round(duration, 3) if duration is not None else None,
        "width": width if isinstance(width, int) else None,
        "height": height if isinstance(height, int) else None,
        "video_codec": video.get("codec_name") if video else None,
        "audio_codec": audio.get("codec_name") if audio else None,
    }


async def probe(source: str, mime: str) -> dict | None:
    """Media metadata for a URL (or, in tests, a local path); None if unknown."""
    import json

    exe = binary("ffprobe")
    inp = _input_args(source, mime)
    if exe is None or inp is None:
        return None
    res = await _run([exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                      *inp], PROBE_TIMEOUT_S)
    if res is None or res[0] != 0:
        return None
    try:
        return parse_probe(json.loads(res[1].decode("utf-8", "replace")))
    except ValueError:
        return None


def poster_time(duration_s: float | None) -> float:
    """About a second in (past a fade from black), or 10% in for a short clip."""
    if not duration_s or duration_s <= 0:
        return 0.0
    return round(min(1.0, duration_s * 0.1), 3)


async def poster(source: str, mime: str, duration_s: float | None) -> bytes | None:
    """One JPEG frame, at most 1280 px wide; None if it can't be made."""
    return await frame(source, mime, poster_time(duration_s))


async def frame(source: str, mime: str, t: float, *, max_width: int = POSTER_MAX_WIDTH) -> bytes | None:
    """One JPEG frame at ``t`` seconds (the poster's recipe at any timestamp —
    creator analytics shows the frame where viewers drop off); None if it
    can't be made."""
    exe = binary("ffmpeg")
    inp = _input_args(source, mime)
    if exe is None or inp is None or not (mime or "").startswith("video/"):
        return None
    t = max(0.0, float(t))
    # -ss before -i: a fast seek on the input, so only the frames near it are read.
    args = [exe, "-nostdin", "-v", "error", "-ss", f"{t:.3f}", *inp,
            "-frames:v", "1", "-an", "-sn", "-dn",
            "-vf", f"scale='min({int(max_width)},iw)':-2",
            "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]
    res = await _run(args, POSTER_TIMEOUT_S)
    if res is None or res[0] != 0:
        return None
    jpg = res[1]
    if not jpg.startswith(b"\xff\xd8") or len(jpg) > POSTER_MAX_BYTES:
        return None
    return jpg


def poster_key_for(blob_key: str) -> str:
    """art/<user>/<random>.poster.jpg beside the video (a fresh random part,
    so a poster key never collides with or reveals its video's key)."""
    import secrets

    owner_dir = blob_key.rsplit("/", 1)[0] if "/" in blob_key else "art"
    return f"{owner_dir}/{secrets.token_urlsafe(18)}.poster.jpg"


_VIDEO_EXTS = (".mp4", ".mov", ".webm", ".ogv", ".m4v")


def frames_prefix(blob_key: str) -> str:
    """Where creator analytics caches frames of a video (private objects):
    ``<blob_key>.f/<second>.jpg``. Deleted with the video."""
    return f"{blob_key}.f/"


def may_have_frames(key: str | None) -> bool:
    return bool(key) and key.lower().endswith(_VIDEO_EXTS)


def wants_probe(mime: str | None) -> bool:
    return (mime or "").lower() in DEMUXERS


async def process(db, doc_id: str, version: int, blob_key: str, mime: str) -> dict | None:
    """Probe a just-swapped file and make its poster, then record both on the
    version row and (if it is still current) on the document. Best effort;
    returns the media dict for tests and logs."""
    from bson import ObjectId
    from fastapi.concurrency import run_in_threadpool

    from app.services import r2

    if not wants_probe(mime) or not r2.is_configured():
        return None
    try:
        url = await run_in_threadpool(r2.presign_get, blob_key, 600)
        media = await probe(url, mime)
        poster_key = None
        if media is not None and mime.startswith("video/") and media.get("width"):
            jpg = await poster(url, mime, media.get("duration_s"))
            if jpg:
                poster_key = poster_key_for(blob_key)
                raw = await db["documents"].find_one({"_id": ObjectId(doc_id)})
                current = bool(raw) and raw.get("blob_key") == blob_key
                from app.services import publicity

                public = current and await publicity.doc_is_public(db, raw)
                if not await run_in_threadpool(r2.put_bytes, poster_key, jpg, "image/jpeg", public):
                    poster_key = None
        if media is None and poster_key is None:
            return None
        await db["file_versions"].update_one(
            {"doc_id": doc_id, "version": int(version)},
            {"$set": {"media": media, "poster_key": poster_key}},
        )
        res = await db["documents"].update_one(
            {"_id": ObjectId(doc_id), "blob_key": blob_key, "poster_key": None},
            {"$set": {"media": media, "poster_key": poster_key}},
        )
        if res.matched_count == 0 and poster_key:
            # The file moved on (replaced again) before the poster was ready;
            # the version row keeps it unless nothing does.
            if not await db["file_versions"].count_documents({"poster_key": poster_key}, limit=1):
                await run_in_threadpool(r2.delete, poster_key)
        return media
    except Exception:  # pragma: no cover - never let a probe hurt anything
        log.warning("media processing failed for %s", blob_key, exc_info=True)
        return None


_TASKS: set[asyncio.Task] = set()


def schedule(db, doc_id: str, version: int, blob_key: str, mime: str) -> None:
    """Fire-and-forget :func:`process` (kept referenced until it finishes)."""
    if not wants_probe(mime):
        return
    try:
        task = asyncio.get_running_loop().create_task(process(db, doc_id, version, blob_key, mime))
    except RuntimeError:
        return
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
