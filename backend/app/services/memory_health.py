"""The API process's memory: what it holds, a watchdog that samples it, and the owners' alert.

Prod incident 2026-11-09: the single uvicorn on a 2 GB box was OOM-killed at 1.6 GB RSS, and after the
restart climbed ~1 GB in 28 minutes in steps that never came back down. Nothing watched it. Now:

* :func:`process` — RSS, swap, peak, threads of this process (``/proc/self/status`` on Linux);
* :func:`caches` — the size of every long-lived in-process structure we know of (a leak shows up
  as one of these growing);
* :func:`tracemalloc_top` — the top Python allocation sites, when the process was started with
  ``MARKDROP_TRACEMALLOC=1`` (app/main.py starts tracing before anything else is imported);
* the watchdog (:func:`start`), in every process (web, worker): every 5 minutes it hands freed heap
  back to the OS (glibc ``malloc_trim``: freed memory otherwise stays in the process's RSS),
  logs ``memory rss=…``, keeps a sample (``ops_memory``, 3 days) for the admin's Product health card,
  and emails the owners — at most once an hour, across processes — when a process is over
  ``memory_alert_rss_mb`` (900) or is using swap.

``GET /api/v1/admin/health/memory`` (routers/admin_health.py) shows all of it.
"""

from __future__ import annotations

import asyncio
import ctypes
import ctypes.util
import gc
import logging
import os
import socket
import sys
import threading
import time
import tracemalloc
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

log = logging.getLogger("markdrop.memory")
settings = get_settings()

COLL = "ops_memory"          # one sample per process per EVERY_S, kept KEEP
ALERTS = "ops_alerts"        # {_id: "memory", last_at}: one alert an hour across processes
EVERY_S = 300.0
KEEP = timedelta(days=3)
ALERT_EVERY = timedelta(hours=1)
STARTED = time.monotonic()
HOST = socket.gethostname()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def role() -> str:
    return settings.role


# ── This process ─────────────────────────────────────────────────────────────


def _proc_status() -> dict[str, int] | None:
    """VmRSS / VmSwap / VmHWM (kB) and Threads from /proc (Linux); None elsewhere."""
    try:
        with open("/proc/self/status") as f:
            out: dict[str, int] = {}
            for line in f:
                k, _, v = line.partition(":")
                if k in ("VmRSS", "VmSwap", "VmHWM", "Threads"):
                    out[k] = int(v.split()[0])
            return out
    except OSError:
        return None


def _ps_rss_kb() -> int:
    """macOS / dev: the current RSS from ps (getrusage only knows the peak)."""
    import subprocess

    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(os.getpid())], capture_output=True, text=True, timeout=2)
        return int(out.stdout.strip() or 0)
    except Exception:
        return 0


def process() -> dict[str, Any]:
    """``{pid, role, rss_mb, swap_mb, peak_mb, threads, tasks, uptime_s}``."""
    st = _proc_status()
    if st is not None:
        rss, swap, peak, threads = st.get("VmRSS", 0), st.get("VmSwap", 0), st.get("VmHWM", 0), st.get("Threads", 0)
    else:
        import resource

        rss = _ps_rss_kb()
        ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        peak = ru // 1024 if sys.platform == "darwin" else ru
        swap, threads = 0, threading.active_count()
    try:
        tasks = len(asyncio.all_tasks())
    except RuntimeError:
        tasks = 0
    return {"pid": os.getpid(), "host": HOST, "role": role(), "rss_mb": round(rss / 1024, 1),
            "swap_mb": round(swap / 1024, 1), "peak_mb": round(peak / 1024, 1), "threads": threads,
            "tasks": tasks, "uptime_s": int(time.monotonic() - STARTED)}


_libc: Any = None


def malloc_trim() -> bool:
    """Hand the C heap's free pages back to the OS (glibc). Python frees objects, but glibc keeps
    the memory (in every thread's arena) for reuse; after a big transient allocation that shows
    as RSS that never comes down. No-op (False) where there is no glibc."""
    global _libc
    if not sys.platform.startswith("linux"):
        return False
    try:
        if _libc is None:
            _libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        return bool(_libc.malloc_trim(0))
    except Exception:
        return False


# ── What the process holds ───────────────────────────────────────────────────


def _len(module: str, attr: str) -> Callable[[], Any]:
    def get():
        import importlib

        mod = sys.modules.get(module) or importlib.import_module(module)
        return len(getattr(mod, attr))

    return get


def _call(module: str, attr: str) -> Callable[[], Any]:
    def get():
        import importlib

        mod = sys.modules.get(module) or importlib.import_module(module)
        return getattr(mod, attr)()

    return get


def _lru(module: str, attr: str) -> Callable[[], Any]:
    def get():
        import importlib

        mod = sys.modules.get(module) or importlib.import_module(module)
        return getattr(mod, attr).cache_info().currsize

    return get


#: name → how to measure it. Each is bounded (by a cap, a TTL or a connection's life); the
#: regression test (tests/test_memory_bounds.py) drives the hot paths and loops and checks these.
KNOWN: dict[str, Callable[[], Any]] = {
    "posthog": _call("app.services.posthog_api", "cache_stats"),
    "live": _call("app.services.live", "stats"),
    "presence": _call("app.services.presence", "stats"),
    "viewers_rooms": _len("app.services.viewers", "_rooms"),
    "viewers_editors": _len("app.services.viewers", "_editors"),
    "viewers_gone_timers": _len("app.services.viewers", "_gone"),
    "share_rooms": _len("app.routers.share", "_rooms"),
    "engage_pending": _len("app.services.engage", "_pending"),
    "analytics_prefs": _len("app.services.analytics_prefs", "_cache"),
    "creator_holds": _len("app.services.creator_analytics", "_hold_cache"),
    "og_rendered": _len("app.routers.og", "_rendered"),
    "docs_index": _len("app.services.docs_index", "_entries"),
    "doc_ref": _call("app.services.doc_ref", "stats"),
    "ai_usage_cache": _len("app.services.ai_usage", "_cache"),
    "ai_usage_recent": _len("app.services.ai_usage", "_recent"),
    "ai_log_cache": _len("app.services.ai_log", "_cache"),
    "ask_names": _len("app.services.ask_me", "_names_cache"),
    "search_pending": _len("app.services.search_index", "_pending"),
    "search_title_words": _lru("app.services.search_text", "title_words"),
    "tenant_cors": _len("app.middleware.tenant_cors", "_cache"),
    "oauth_access": _len("app.services.oauth_server", "_access_cache"),
    "slack_names": _len("app.services.slack_action_items", "_NAMES"),
    "jira_locks": _len("app.services.jira", "_locks"),
    "analytics_ai_locks": _len("app.services.analytics_ai_doc", "_locks"),
    "tasks_meetings": _len("app.services.meetings", "_bg"),
    "tasks_jira": _len("app.services.jira", "_bg"),
    "tasks_slack": _len("app.services.slack", "_bg"),
    "tasks_ask_suggestions": _len("app.services.ask_suggestions", "_bg"),
    "tasks_revalidate": _len("app.services.revalidate", "_TASKS"),
    "tasks_page_covers": _len("app.services.page_covers", "_TASKS"),
    "tasks_user": _len("app.services.user", "_bg_tasks"),
    "tasks_media": _len("app.services.media", "_TASKS"),
    "tasks_uploads": _len("app.services.file_uploads", "_RUNNING"),
    "tasks_card_preview": _len("app.services.card_preview", "_RUNNING"),
}


def caches() -> dict[str, Any]:
    """Sizes of the known long-lived structures (a module not loaded in this process is skipped)."""
    out: dict[str, Any] = {}
    for name, get in KNOWN.items():
        try:
            out[name] = get()
        except Exception:
            out[name] = None
    return out


def gc_stats() -> dict[str, Any]:
    return {"counts": list(gc.get_count()), "frozen": gc.get_freeze_count(),
            "collections": [s.get("collections") for s in gc.get_stats()],
            "uncollectable": sum(s.get("uncollectable", 0) for s in gc.get_stats())}


def tracemalloc_top(n: int = 20) -> dict[str, Any] | None:
    """The top ``n`` allocation sites (by size, grouped by line) and the traced total, when tracing."""
    if not tracemalloc.is_tracing():
        return None
    snap = tracemalloc.take_snapshot().filter_traces((
        tracemalloc.Filter(False, tracemalloc.__file__),
        tracemalloc.Filter(False, "<frozen importlib._bootstrap>"),
        tracemalloc.Filter(False, "<unknown>"),
    ))
    current, peak = tracemalloc.get_traced_memory()
    top = [{"where": f"{s.traceback[0].filename.split('/site-packages/')[-1].split('/backend/')[-1]}:{s.traceback[0].lineno}",
            "kb": round(s.size / 1024, 1), "count": s.count} for s in snap.statistics("lineno")[:n]]
    return {"traced_mb": round(current / 2**20, 1), "peak_mb": round(peak / 2**20, 1), "top": top}


def report() -> dict[str, Any]:
    return {"process": process(), "caches": caches(), "gc": gc_stats(), "tracemalloc": tracemalloc_top(),
            "alert": {"rss_mb": settings.memory_alert_rss_mb, "swap_mb": settings.memory_alert_swap_mb}}


# ── Samples and the alert ────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("at", expireAfterSeconds=int(KEEP.total_seconds()), name="ops_memory_ttl")
    await db[COLL].create_index([("role", 1), ("at", 1)])


def over(p: dict[str, Any]) -> str | None:
    """Why this sample warrants the owners' attention, or None."""
    if p["rss_mb"] >= settings.memory_alert_rss_mb:
        return f"RSS {p['rss_mb']:.0f} MB is over {settings.memory_alert_rss_mb} MB"
    if p["swap_mb"] >= settings.memory_alert_swap_mb:
        return f"{p['swap_mb']:.0f} MB of it is in swap"
    return None


async def _claim_alert(db: AsyncIOMotorDatabase, now: datetime) -> bool:
    """True for the one process allowed to alert this hour."""
    try:
        row = await db[ALERTS].find_one_and_update(
            {"_id": "memory", "$or": [{"last_at": {"$lt": now - ALERT_EVERY}}, {"last_at": None}]},
            {"$set": {"last_at": now}}, upsert=True, return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:
        return False  # alerted within the hour (the filter missed, and the upsert hit the row)
    return row is not None


async def alert(db: AsyncIOMotorDatabase, p: dict[str, Any], why: str) -> bool:
    """Email every owner (MARKDROP_ADMIN_EMAILS) about ``p``; at most one an hour. True when sent."""
    from app.services import mailer

    now = _now()
    if not await _claim_alert(db, now):
        return False
    mail = mailer.compose_ops_alert(host=p["host"], role=p["role"], pid=p["pid"], why=why, rss_mb=p["rss_mb"],
                                    swap_mb=p["swap_mb"], peak_mb=p["peak_mb"], uptime_s=p["uptime_s"],
                                    top=sorted(((k, v) for k, v in caches().items() if isinstance(v, int)),
                                               key=lambda kv: -kv[1])[:6])
    sent = False
    for to in sorted(settings.admin_email_set):
        try:
            await mailer.send_ops_alert_email(to_email=to, mail=mail)
            sent = True
        except Exception:
            log.warning("memory alert to %s failed", to, exc_info=True)
    return sent


async def tick(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """One watchdog pass: trim, prune what expires, sample, keep, maybe alert."""
    try:
        from app.services import posthog_api

        posthog_api._prune(time.monotonic())
    except Exception:
        pass
    trimmed = malloc_trim()
    p = process()
    log.info("memory rss=%.0fMB swap=%.0fMB peak=%.0fMB threads=%d tasks=%d role=%s pid=%d trimmed=%s",
             p["rss_mb"], p["swap_mb"], p["peak_mb"], p["threads"], p["tasks"], p["role"], p["pid"], trimmed)
    try:
        await db[COLL].insert_one({"at": _now(), **{k: p[k] for k in ("host", "pid", "role", "rss_mb", "swap_mb",
                                                                       "peak_mb", "threads", "tasks")}})
    except Exception:
        log.warning("memory sample not stored", exc_info=True)
    why = over(p)
    if why:
        log.warning("memory over the line: %s (%s pid %d)", why, p["role"], p["pid"])
        try:
            p["alerted"] = await alert(db, p, why)
        except Exception:
            log.warning("memory alert failed", exc_info=True)
    return p


async def history(db: AsyncIOMotorDatabase, hours: int = 24) -> list[dict[str, Any]]:
    """Samples of the last ``hours``: ``[{at, role, pid, rss_mb, swap_mb}]``, oldest first."""
    since = _now() - timedelta(hours=max(1, min(72, hours)))
    rows = await db[COLL].find({"at": {"$gte": since}}, {"_id": 0, "at": 1, "role": 1, "pid": 1, "host": 1,
                                                         "rss_mb": 1, "swap_mb": 1}).sort("at", 1).to_list(length=5000)
    for r in rows:
        at = r["at"]
        r["at"] = (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).isoformat()
    return rows


# ── The watchdog loop ────────────────────────────────────────────────────────

_task: asyncio.Task | None = None


async def _loop(get_db: Callable[[], AsyncIOMotorDatabase], every: float) -> None:
    await asyncio.sleep(min(60.0, every))  # the first sample once startup's allocations settled
    while True:
        try:
            await tick(get_db())
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("memory watchdog failed", exc_info=True)
        await asyncio.sleep(every)


def start(get_db: Callable[[], AsyncIOMotorDatabase], every: float = EVERY_S) -> None:
    global _task
    if not settings.memory_watchdog_enabled or (_task is not None and not _task.done()):
        return
    _task = asyncio.get_running_loop().create_task(_loop(get_db, every))


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):
            pass
    _task = None
