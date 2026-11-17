"""Exact previews of PowerPoint decks: each uploaded .pptx is converted to a PDF by headless
LibreOffice, and the file's page shows that PDF in the PDF viewer.

The Worker's slide viewer (worker/src/pptx.js) draws a deck from its XML in the browser, which gets
layouts, backgrounds and shape geometry wrong. LibreOffice lays the deck out the way PowerPoint and
Keynote do (with the fonts it has: see the server setup note in the brief), so the PDF is what the
reader should see. The original .pptx is still what "Download" saves.

Lifecycle, per uploaded deck (one *blob*, i.e. one file version)::

    upload / replace / restore ──schedule()──► pptx_previews row {_id: blob_key, state: "pending"}
                                               documents.pptx_pdf = {for: blob_key, state: "pending"}
    background loop "pptx_preview" (services/background.py, one conversion at a time, under a lease)
        ──► soffice --headless --convert-to pdf  (isolated temp dir + profile, timeout, size limit)
        ──► R2 ``<blob_key>.pdf`` (beside the deck, private until the document's publicity says
            otherwise), row ``ready`` with the page count and each slide's text
        ──► documents.pptx_pdf = {for, state: "ready", pages}; rev bumped, live viewers re-read

Readers get ``artifact_url`` pointing at ``/v/pdf/<blob_key>.pdf`` once ``ready`` (publicity.byte_urls,
artifact.to_response) and ``pdf_preview`` = "converting" | "ready" | "failed" so the app can say
"Preparing an exact preview…" or "Preview may differ from PowerPoint" over the slide viewer.

A PDF belongs to its blob, never to the document, so every file version keeps its own: restoring an
old version finds its row ``ready`` and points the document back at that PDF without converting
again. The PDF follows the document's publicity exactly like a video's poster (publicity.apply,
file_versions.apply_publicity) and is deleted with its deck (:func:`forget_document`,
:func:`forget_blobs`).

Off (``MARKDROP_PPTX_CONVERT=false``, or no LibreOffice on PATH): nothing is scheduled and decks
keep the slide viewer, exactly as before. Slide numbers and page numbers agree (hidden slides are
exported too, as the slide viewer shows them), so ``#slide=5`` opens page 5.

:func:`slide_texts` is the text of each slide for MCP fetch/get_document (by slide number, with
notes), from the cached conversion when there is one, else read from the deck.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from bson import ObjectId
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

COLL = "pptx_previews"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
PDF_MIME = "application/pdf"
LOCK = "pptx_preview"           # the background loop's lease (services/background.py)
MAX_TRIES = 3
BACKFILL_BATCH = 5              # decks from before this feature, scheduled per pass
SLIDE_TEXT_MAX = 200_000        # characters of slide text kept on a row

PENDING, RUNNING, READY, FAILED = "pending", "running", "ready", "failed"
# What readers are told (API ``pdf_preview``).
STATES = {PENDING: "converting", RUNNING: "converting", READY: "ready", FAILED: "failed"}

# Hidden slides are exported (slide N = page N), speaker notes pages are not.
PDF_FILTER = ('pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"},'
              '"ExportNotesPages":{"type":"boolean","value":"false"}}')

# A fresh LibreOffice profile per conversion: macros never run, untrusted links are blocked.
_PROFILE_XCU = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" \
xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" \
oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" \
oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" \
oor:op="fuse"><value>true</value></prop></item>
</oor:items>
"""


class ConvertError(Exception):
    """The deck couldn't be converted (no LibreOffice, a timeout, no PDF came out...)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get(doc: Any, name: str, default=None):
    if isinstance(doc, dict):
        return doc.get(name, default)
    return getattr(doc, name, default)


# ── Configuration ─────────────────────────────────────────────────────────────


def binary() -> str | None:
    """The LibreOffice binary: the configured one, else ``soffice`` / ``libreoffice`` on PATH."""
    configured = settings.pptx_convert_bin
    if configured:
        return shutil.which(configured)
    return shutil.which("soffice") or shutil.which("libreoffice")


def enabled() -> bool:
    """MARKDROP_PPTX_CONVERT: on when LibreOffice is found (unset), never when false."""
    if settings.pptx_convert is False:
        return False
    return binary() is not None


def is_deck(mime: str | None) -> bool:
    return (mime or "").split(";")[0].strip().lower() == PPTX_MIME


def pdf_key_for(blob_key: str) -> str:
    """Where a deck's PDF lives: beside it, under the same owner prefix (``art/<user>/x.pptx.pdf``)."""
    return f"{blob_key}.pdf"


# ── What readers see ──────────────────────────────────────────────────────────


def _current(doc: Any) -> dict | None:
    """The document's ``pptx_pdf`` when it describes its current bytes, else None."""
    if _get(doc, "kind") != "artifact" or not is_deck(_get(doc, "mime")):
        return None
    info = _get(doc, "pptx_pdf")
    blob = _get(doc, "blob_key")
    if not isinstance(info, dict) or not blob or info.get("for") != blob:
        return None
    return info


def pdf_key_of(doc: Any) -> str | None:
    """The R2 key of the document's ready PDF preview (for its current file), else None."""
    info = _current(doc)
    if info and info.get("state") == READY:
        return pdf_key_for(_get(doc, "blob_key"))
    return None


def state_of(doc: Any) -> str | None:
    """API ``pdf_preview``: "converting" | "ready" | "failed" for a deck, None otherwise (another
    type, conversion off, or a deck from before it that the backfill hasn't reached yet)."""
    info = _current(doc)
    if info is None:
        return None
    state = info.get("state")
    if state == READY:
        return "ready"
    if state == FAILED:
        return "failed"
    return "converting" if enabled() else None


def viewer_target(doc: Any) -> tuple[str, str] | None:
    """(key, mime) the viewer should render instead of the deck: its ready PDF."""
    key = pdf_key_of(doc)
    return (key, PDF_MIME) if key else None


# ── Scheduling ────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("state", 1), ("created_at", 1)])
    await db[COLL].create_index("doc_id")


async def _set_doc(db: AsyncIOMotorDatabase, doc_id: str, blob_key: str, info: dict, *,
                   bump: bool = False) -> dict | None:
    """Write ``pptx_pdf`` while the document still points at ``blob_key``; the row after, or None."""
    if not ObjectId.is_valid(doc_id):
        return None
    update: dict[str, Any] = {"$set": {"pptx_pdf": {"for": blob_key, **info}}}
    if bump:
        update["$inc"] = {"rev": 1}
    return await db["documents"].find_one_and_update(
        {"_id": ObjectId(doc_id), "blob_key": blob_key}, update, return_document=True)


async def schedule(db: AsyncIOMotorDatabase, doc_id: str, blob_key: str | None, mime: str | None) -> None:
    """Queue a deck's conversion (a new upload, a replacement) or point the document at the PDF its
    bytes already have (a restored version). Never raises; does nothing when conversion is off."""
    if not blob_key or not is_deck(mime) or not enabled():
        return
    try:
        row = await db[COLL].find_one({"_id": blob_key}, {"slides": 0})
        if row is None:
            try:
                await db[COLL].insert_one({"_id": blob_key, "doc_id": str(doc_id), "state": PENDING,
                                           "tries": 0, "created_at": _now()})
            except Exception:  # a concurrent schedule of the same blob: one row is enough
                pass
            await _set_doc(db, str(doc_id), blob_key, {"state": PENDING})
            return
        if row.get("state") == READY:
            await _attach(db, str(doc_id), blob_key, row)
            return
        await _set_doc(db, str(doc_id), blob_key,
                       {"state": FAILED if row.get("state") == FAILED else PENDING})
    except Exception:  # pragma: no cover - never fail an upload over a preview
        log.warning("scheduling the PDF preview of %s failed", blob_key, exc_info=True)


async def _attach(db: AsyncIOMotorDatabase, doc_id: str, blob_key: str, row: dict) -> bool:
    """Point the document at a ready PDF: publicity first (a public page links it unsigned), then the
    document, then live viewers and the cached page. False when the document moved on."""
    from app.services import live, publicity, r2, revalidate

    raw = await db["documents"].find_one({"_id": ObjectId(doc_id)}) if ObjectId.is_valid(doc_id) else None
    if not raw or raw.get("blob_key") != blob_key:
        return False
    key = pdf_key_for(blob_key)
    public = await publicity.doc_is_public(db, raw)
    await run_in_threadpool(r2.set_public, key, public, PDF_MIME, publicity.epoch_of(raw))
    after = await _set_doc(db, doc_id, blob_key, {"state": READY, "pages": row.get("pages")}, bump=True)
    if after is None:
        return False
    # Narrowed while this ran (publicity.apply didn't know the PDF yet): close it again.
    now_public = await publicity.doc_is_public(db, after)
    if now_public != public:
        await run_in_threadpool(r2.set_public, key, now_public, PDF_MIME, publicity.epoch_of(after))
    live.publish(after["slug"], int(after.get("rev", 1)))
    try:
        await revalidate.purge_doc(db, after)
    except Exception:  # pragma: no cover
        log.warning("purging %s after its PDF preview failed", after.get("slug"), exc_info=True)
    return True


async def _fail(db: AsyncIOMotorDatabase, row: dict, reason: str) -> None:
    from app.services import live

    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"state": FAILED, "error": reason[:500],
                                                            "updated_at": _now()}})
    after = await _set_doc(db, row.get("doc_id") or "", row["_id"], {"state": FAILED}, bump=True)
    if after is not None:
        live.publish(after["slug"], int(after.get("rev", 1)))
    log.info("PDF preview of %s failed: %s", row["_id"], reason)


# ── Converting ────────────────────────────────────────────────────────────────


def _kill(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)   # soffice starts soffice.bin: the whole group
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


async def convert(data: bytes, *, timeout: float | None = None) -> bytes:
    """The deck as a PDF, made by headless LibreOffice in a throwaway directory with a throwaway
    profile (no shell, a minimal environment, killed with its children on timeout). Raises
    :class:`ConvertError`."""
    exe = binary()
    if exe is None:
        raise ConvertError("LibreOffice isn't installed")
    timeout = float(timeout or settings.pptx_convert_timeout_s)
    with tempfile.TemporaryDirectory(prefix="md-pptx-") as tmp:
        root = Path(tmp)
        src, out, profile = root / "deck.pptx", root / "out", root / "profile"
        out.mkdir()
        (profile / "user").mkdir(parents=True)
        (profile / "user" / "registrymodifications.xcu").write_text(_PROFILE_XCU)
        src.write_bytes(data)
        args = [exe, f"-env:UserInstallation={profile.as_uri()}", "--headless", "--invisible",
                "--nologo", "--nodefault", "--nofirststartwizard", "--norestore", "--nolockcheck",
                "--convert-to", PDF_FILTER, "--outdir", str(out), str(src)]
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp, "TMPDIR": tmp,
               "LANG": "C.UTF-8", "SAL_USE_VCLPLUGIN": "svp"}
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=env, cwd=tmp, start_new_session=True)
        except (OSError, ValueError) as exc:
            raise ConvertError(f"LibreOffice couldn't start ({exc})") from exc
        try:
            _out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            _kill(proc)
            await proc.wait()
            raise ConvertError(f"timed out after {int(timeout)} s")
        except asyncio.CancelledError:
            _kill(proc)
            raise
        pdf = out / "deck.pdf"
        if not pdf.is_file():
            tail = (err or b"").decode("utf-8", "replace").strip()[-300:]
            raise ConvertError(f"no PDF came out (exit {proc.returncode}){': ' + tail if tail else ''}")
        body = pdf.read_bytes()
    if not body.startswith(b"%PDF-"):
        raise ConvertError("the output isn't a PDF")
    return body


# Tests replace this with a fake (CI has no LibreOffice).
CONVERTER: Callable[[bytes], Awaitable[bytes]] = convert


def _page_count(pdf: bytes) -> int | None:
    import io

    try:
        from pypdf import PdfReader

        return len(PdfReader(io.BytesIO(pdf)).pages)
    except Exception:
        return None


def _deck_slides(data: bytes) -> tuple[int, list[dict]]:
    """(slide count, [{slide, text}] for every slide, empty ones included)."""
    from app.services import file_text

    total, parts = file_text.pptx_slides(data)
    texts: dict[int, str] = {}
    for p in parts:
        try:
            texts[int((p.label or "").rsplit(" ", 1)[-1])] = p.text
        except ValueError:
            continue
    return total, [{"slide": n, "text": texts.get(n, "")} for n in range(1, total + 1)]


def _cap_slides(slides: list[dict]) -> list[dict]:
    out, size = [], 0
    for s in slides:
        text = s["text"][: max(0, SLIDE_TEXT_MAX - size)]
        size += len(text)
        out.append({"slide": s["slide"], "text": text})
    return out


async def _referenced(db: AsyncIOMotorDatabase, blob_key: str) -> bool:
    """Whether any document, version or trashed item still holds this deck."""
    return bool(
        await db["documents"].count_documents({"blob_key": blob_key}, limit=1)
        or await db["file_versions"].count_documents({"blob_key": blob_key}, limit=1)
        or await db["trash"].count_documents({"doc.blob_key": blob_key}, limit=1))


async def _claim(db: AsyncIOMotorDatabase) -> dict | None:
    """The oldest pending row (or a running one a stopped process left behind), now ours."""
    stale = _now() - timedelta(seconds=settings.pptx_convert_timeout_s + 300)
    return await db[COLL].find_one_and_update(
        {"$or": [{"state": PENDING}, {"state": RUNNING, "claimed_at": {"$lt": stale}}]},
        {"$set": {"state": RUNNING, "claimed_at": _now()}, "$inc": {"tries": 1}},
        sort=[("created_at", 1)], projection={"slides": 0}, return_document=True)


async def process(db: AsyncIOMotorDatabase, row: dict) -> str:
    """Convert one claimed row. Returns its new state (or "gone")."""
    from app.services import r2

    blob_key = row["_id"]
    if not await _referenced(db, blob_key):
        await db[COLL].delete_one({"_id": blob_key})
        return "gone"
    if int(row.get("tries") or 0) > MAX_TRIES:
        await _fail(db, row, "gave up after repeated attempts")
        return FAILED
    cap = int(settings.pptx_convert_max_bytes)
    data = await run_in_threadpool(r2.get_bytes, blob_key, cap + 1)
    if data is None:
        await db[COLL].update_one({"_id": blob_key}, {"$set": {"state": PENDING}})  # storage blip
        return PENDING
    if len(data) > cap:
        await _fail(db, row, f"the deck is larger than {cap // (1024 * 1024)} MB")
        return FAILED
    try:
        pdf = await CONVERTER(data)
    except ConvertError as exc:
        await _fail(db, row, str(exc))
        return FAILED
    except Exception as exc:  # pragma: no cover - a converter bug must not wedge the queue
        log.warning("converting %s failed", blob_key, exc_info=True)
        await _fail(db, row, f"conversion error ({type(exc).__name__})")
        return FAILED
    pages = await run_in_threadpool(_page_count, pdf)
    try:
        total, slides = await run_in_threadpool(_deck_slides, data)
    except Exception:
        total, slides = pages or 0, []
    key = pdf_key_for(blob_key)
    if not await run_in_threadpool(r2.put_bytes, key, pdf, PDF_MIME, False):
        await db[COLL].update_one({"_id": blob_key}, {"$set": {"state": PENDING}})
        return PENDING
    if not await _referenced(db, blob_key):   # deleted while converting
        await run_in_threadpool(r2.delete, key)
        await db[COLL].delete_one({"_id": blob_key})
        return "gone"
    ready = {"state": READY, "pages": pages, "slide_count": total, "slides": _cap_slides(slides),
             "pdf_bytes": len(pdf), "error": None, "updated_at": _now()}
    await db[COLL].update_one({"_id": blob_key}, {"$set": ready})
    # The document may have been replaced meanwhile: then only the version row's blob has it, and a
    # restore attaches it later (schedule).
    await _attach(db, row.get("doc_id") or "", blob_key, ready)
    return READY


_ONE_AT_A_TIME = asyncio.Lock()
_BACKFILL = {"next": 0.0}
BACKFILL_IDLE_S = 600.0


async def tick(db: AsyncIOMotorDatabase) -> int:
    """One pass of the background loop: schedule a few decks from before this feature, then convert
    pending ones, one at a time, for up to about a minute. Returns how many were converted."""
    from app.services import background

    if not enabled():
        return 0
    # The backfill scans documents: every pass while it finds a full batch, else every 10 minutes.
    loop_now = asyncio.get_running_loop().time()
    if loop_now >= _BACKFILL["next"]:
        found = await backfill(db)
        _BACKFILL["next"] = loop_now + (0 if found >= BACKFILL_BATCH else BACKFILL_IDLE_S)
    done = 0
    deadline = asyncio.get_running_loop().time() + 60
    async with _ONE_AT_A_TIME:
        while asyncio.get_running_loop().time() < deadline:
            # Hold the loop's lease for longer than one conversion can take, so no other process
            # starts converting beside this one.
            ttl = timedelta(seconds=settings.pptx_convert_timeout_s + 120)
            if not await background.acquire(db, LOCK, ttl):
                break
            row = await _claim(db)
            if row is None:
                break
            if await process(db, row) == READY:
                done += 1
    return done


async def backfill(db: AsyncIOMotorDatabase, limit: int = BACKFILL_BATCH) -> int:
    """Decks uploaded before conversion existed (or while it was off) get scheduled, a few a pass."""
    n = 0
    cur = db["documents"].find({"kind": "artifact", "mime": PPTX_MIME, "pptx_pdf": {"$exists": False},
                                "blob_key": {"$ne": None}}, {"blob_key": 1, "mime": 1}).limit(limit)
    async for d in cur:
        await schedule(db, str(d["_id"]), d.get("blob_key"), d.get("mime"))
        n += 1
    return n


# ── Deleting ──────────────────────────────────────────────────────────────────


async def forget_blobs(db: AsyncIOMotorDatabase, keys) -> None:
    """These decks are deleted: their PDFs and rows go too."""
    from app.services import r2

    for key in {k for k in keys or () if k}:
        try:
            row = await db[COLL].find_one_and_delete({"_id": key}, projection={"_id": 1})
            if row is not None and r2.is_configured():
                await run_in_threadpool(r2.delete, pdf_key_for(key))
        except Exception:  # pragma: no cover - never fail a delete over this
            log.warning("PDF preview of %s not deleted", key, exc_info=True)


async def forget_document(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    """A document is destroyed: every PDF made for any of its versions goes with it."""
    keys = [r["_id"] async for r in db[COLL].find({"doc_id": str(doc_id)}, {"_id": 1})]
    await forget_blobs(db, keys)


# ── Slide text (MCP fetch / get_document) ─────────────────────────────────────


async def slide_texts(db: AsyncIOMotorDatabase, raw: dict, *, slide_from: int = 1,
                      slide_to: int | None = None) -> dict | None:
    """The text of a deck's slides, by slide number (slide N = page N of its PDF preview), for a
    caller that has already decided the reader may read ``raw``::

        {"total_slides": 12, "slides": [{"slide": 1, "text": "Title\\nNotes: ..."}, ...],
         "pdf_preview": "ready" | "converting" | "failed" | None}

    Every slide in the range is listed, empty ones with ``text: ""``. None when ``raw`` isn't a
    deck or its bytes can't be read. Text comes from the conversion's cache when there is one, else
    from the deck itself (the same reader as search)."""
    from app.services import file_text, r2

    blob = raw.get("blob_key")
    if raw.get("kind") != "artifact" or not blob or not is_deck(raw.get("mime")):
        return None
    row = await db[COLL].find_one({"_id": blob, "state": READY}, {"slides": 1, "slide_count": 1})
    if row and row.get("slides") is not None:
        total, slides = int(row.get("slide_count") or len(row["slides"])), row["slides"]
    else:
        if not r2.is_configured():
            return None
        data = await run_in_threadpool(r2.get_bytes, blob, int(settings.pptx_convert_max_bytes))
        if data is None:
            return None
        try:
            total, slides = await run_in_threadpool(_deck_slides, data)
        except file_text.Refused:
            return None
    lo = max(1, int(slide_from or 1))
    hi = min(total, int(slide_to)) if slide_to else total
    return {"total_slides": total,
            "slides": [s for s in slides if lo <= int(s["slide"]) <= hi],
            "pdf_preview": state_of(raw)}
