"""Shared slowapi limiter.

Lives in its own module so any router can import it without creating an
import cycle. Keyed on the real client IP (behind nginx) and backed by Redis
so limits are shared across workers and survive restarts.

Redis is a dependency of the *limits*, not of the routes: when it is down or
hangs, limiting falls back to per-process memory (and, failing that, lets the
request through) instead of answering 500 — and short socket timeouts keep a
hung Redis from holding every request for the length of the pause.
"""

from slowapi import Limiter

from app.config import get_settings
from app.utils.net import get_client_ip

settings = get_settings()

# Passed to the Redis client only (memory:// ignores them).
STORAGE_OPTIONS = {"socket_timeout": 0.5, "socket_connect_timeout": 0.5}


def build_limiter(storage_uri: str) -> Limiter:
    return Limiter(
        key_func=get_client_ip,
        storage_uri=storage_uri,
        storage_options=dict(STORAGE_OPTIONS) if storage_uri.startswith(("redis", "rediss", "unix")) else {},
        in_memory_fallback_enabled=True,
        swallow_errors=True,
    )


limiter = build_limiter(settings.redis_url)
