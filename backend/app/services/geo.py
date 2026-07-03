"""IP → geography via the local MaxMind GeoLite2 City database.

Degrades gracefully: if the DB isn't configured/present (e.g. local dev) or
the IP is private/unknown, every field comes back None. The reader is opened
once and reused (mmap-backed, thread-safe for reads).
"""

import os

import geoip2.database
import geoip2.errors

from app.config import get_settings

settings = get_settings()

_reader: "geoip2.database.Reader | None" = None
_loaded = False


def _get_reader() -> "geoip2.database.Reader | None":
    global _reader, _loaded
    if _loaded:
        return _reader
    _loaded = True
    path = settings.geoip_db_path
    if path and os.path.exists(path):
        try:
            _reader = geoip2.database.Reader(path)
        except Exception:
            _reader = None
    return _reader


def lookup(ip: str | None) -> dict:
    """Return {country, region, city} (ISO country code) — any may be None."""
    empty = {"country": None, "region": None, "city": None}
    reader = _get_reader()
    if not reader or not ip:
        return empty
    try:
        r = reader.city(ip)
    except (geoip2.errors.AddressNotFoundError, ValueError):
        return empty
    except Exception:
        return empty
    return {
        "country": r.country.iso_code,
        "region": r.subdivisions.most_specific.name,
        "city": r.city.name,
    }
