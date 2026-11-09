"""Event-loop lag: how long the API's one event loop was busy when it should have been answering.

One process serves every request on a single event loop, so a handler that does CPU work (or a
synchronous call) without awaiting holds every other request — page reads, lock heartbeats, the
live socket — for as long as it runs. This module measures that and says who did it:

* a ticker (an asyncio task) wakes every ``TICK`` seconds and records how late it woke: the lag.
  ``snapshot()`` reports the worst and the count over thresholds since the last snapshot;
* a watchdog thread notices when the ticker has not run for ``block_ms`` and captures the loop
  thread's stack at that moment, so the log names the function holding the loop (rate limited: one
  line per block, at most ``MAX_REPORTS_PER_MIN`` a minute).

Cheap enough to leave on in production (a 100 ms timer and a thread that wakes every 25 ms).
``MARKDROP_LOOP_MONITOR=0`` turns it off; ``MARKDROP_LOOP_BLOCK_MS`` moves the report threshold.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import threading
import time
import traceback

log = logging.getLogger("markdrop.loop")

TICK = 0.1
MAX_REPORTS_PER_MIN = 6
_BUCKETS = (10, 50, 100, 250, 1000)

_state: dict = {}


def _reset_window() -> None:
    _state["win_max"] = 0.0
    _state["win_n"] = 0
    _state["win_over"] = {b: 0 for b in _BUCKETS}
    _state["win_started"] = time.monotonic()


async def _ticker() -> None:
    _state["thread_id"] = threading.get_ident()
    while True:
        t0 = time.monotonic()
        _state["beat"] = t0
        await asyncio.sleep(TICK)
        lag_ms = (time.monotonic() - t0 - TICK) * 1000.0
        if lag_ms < 0:
            lag_ms = 0.0
        _state["win_n"] += 1
        if lag_ms > _state["win_max"]:
            _state["win_max"] = lag_ms
        if lag_ms > _state["all_max"]:
            _state["all_max"] = lag_ms
        for b in _BUCKETS:
            if lag_ms > b:
                _state["win_over"][b] += 1


def _frames(thread_id: int, limit: int = 14) -> str:
    frame = sys._current_frames().get(thread_id)
    if frame is None:
        return "?"
    stack = traceback.extract_stack(frame)[-limit:]
    return " <- ".join(f"{os.path.basename(f.filename)}:{f.lineno} {f.name}" for f in reversed(stack))


def _watchdog(block_s: float, stop: threading.Event) -> None:
    reported_for = None
    window_start, reports = time.monotonic(), 0
    while not stop.wait(0.025):
        beat = _state.get("beat")
        tid = _state.get("thread_id")
        if beat is None or tid is None:
            continue
        now = time.monotonic()
        if now - window_start > 60:
            window_start, reports = now, 0
        # The ticker is due every TICK; past that by block_s, something is holding the loop.
        if now - beat > TICK + block_s and reported_for != beat:
            reported_for = beat
            stack = _frames(tid)
            _state["blocks"].append({"at": time.time(), "stack": stack})
            del _state["blocks"][:-50]
            if reports < MAX_REPORTS_PER_MIN:
                reports += 1
                log.warning("event loop blocked > %d ms: %s", int(block_s * 1000), stack)


def start() -> None:
    """Start the ticker and the watchdog on the running loop. Idempotent."""
    if _state.get("task") or os.environ.get("MARKDROP_LOOP_MONITOR", "1") == "0":
        return
    block_s = float(os.environ.get("MARKDROP_LOOP_BLOCK_MS", "200")) / 1000.0
    _state.update(all_max=0.0, blocks=[], beat=None, thread_id=None)
    _reset_window()
    _state["task"] = asyncio.get_running_loop().create_task(_ticker())
    stop = threading.Event()
    _state["stop"] = stop
    threading.Thread(target=_watchdog, args=(block_s, stop), name="loop-watchdog", daemon=True).start()


async def stop() -> None:
    task = _state.pop("task", None)
    if _state.get("stop"):
        _state.pop("stop").set()
    if task:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


def snapshot(reset: bool = False) -> dict:
    """Lag since the last reset: ticks, the worst lag, ticks over each threshold, recent blocks."""
    if "win_n" not in _state:
        return {"enabled": False}
    out = {
        "enabled": bool(_state.get("task")),
        "seconds": round(time.monotonic() - _state["win_started"], 1),
        "ticks": _state["win_n"],
        "max_ms": round(_state["win_max"], 1),
        "all_time_max_ms": round(_state["all_max"], 1),
        "over_ms": {str(b): n for b, n in _state["win_over"].items()},
        "blocks": list(_state["blocks"][-20:]),
    }
    if reset:
        _reset_window()
        _state["blocks"].clear()
    return out
