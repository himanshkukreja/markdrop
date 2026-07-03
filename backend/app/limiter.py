"""Shared slowapi limiter.

Lives in its own module so any router can import it without creating an
import cycle. Keyed on the real client IP (behind nginx) and backed by Redis
so limits are shared across workers and survive restarts.
"""

from slowapi import Limiter

from app.config import get_settings
from app.utils.net import get_client_ip

settings = get_settings()

limiter = Limiter(key_func=get_client_ip, storage_uri=settings.redis_url)
