"""The background loops, on their own or inside the API process.

``MARKDROP_ROLE`` (app/config.py) picks who runs them:

* ``all`` (default): the API process runs the loops beside the requests, as before.
* ``web``: the API serves requests only (any number of uvicorn workers); no loop work ever sits in
  front of a request on its event loop.
* ``worker``: ``python -m app.worker`` (the ``markdrop-worker`` systemd service) runs the loops and
  no HTTP server.

Every loop still takes its Mongo lease (services/background.py), so a mistake that starts them twice
does each pass once. Both roles run the memory watchdog (services/memory_health.py). Documents a loop
changes are announced to the web processes' open sockets over Redis (services/live.py: the bus).
"""

from __future__ import annotations

import asyncio
import gc
import logging
import signal

from app.config import get_settings

log = logging.getLogger("markdrop.worker")
settings = get_settings()


def runs_loops() -> bool:
    return settings.role in ("all", "worker")


async def start_loops() -> None:
    from app.database import get_database
    from app.services import analytics_digest, background, docs_dispatch, domain_monitor
    from app.services.email_campaigns import engine as email_engine

    # Campaign sender: sends queued campaigns in the background and resumes
    # them after a restart (services/email_campaigns/engine.py).
    email_engine.start(get_database)
    # Revalidation outbox, expiry sweeper, access reconciler (services/background.py),
    # and custom-domain re-verification / lapsing (services/domain_monitor.py).
    # Each runs one worker per pass via a Mongo lease.
    background.start(get_database)
    domain_monitor.start(get_database)
    # Markdrop Docs jobs: route each to GitHub Actions or the local worker, dispatch, sweep
    # (services/docs_dispatch.py; a lease, one API worker per pass).
    docs_dispatch.start(get_database)
    # Weekly analytics digest: off unless MARKDROP_ANALYTICS_DIGEST_ENABLED
    # (and background workers) are on; a lease + per-user claims, never twice.
    analytics_digest.start(get_database)


async def stop_loops() -> None:
    from app.services import analytics_digest, background, docs_dispatch, domain_monitor
    from app.services.email_campaigns import engine as email_engine

    await analytics_digest.stop()
    await docs_dispatch.stop()
    await domain_monitor.stop()
    await background.stop()
    await email_engine.stop()


async def main() -> None:
    import app.main  # noqa: F401  (the same module state as the web process: hooks, routers' imports)
    from app.database import connect, disconnect, get_database
    from app.services import live, memory_health

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if settings.role != "worker":
        log.warning("MARKDROP_ROLE is %r; the worker runs the loops anyway (set MARKDROP_ROLE=worker, and web "
                    "for the API, so they don't run twice)", settings.role)
    await connect()
    await start_loops()
    memory_health.start(get_database)
    live.start_bus()
    gc.collect()
    gc.freeze()
    log.info("worker up: background loops running")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    log.info("worker stopping")
    await live.stop_bus()
    await memory_health.stop()
    await stop_loops()
    await disconnect()


if __name__ == "__main__":
    asyncio.run(main())
