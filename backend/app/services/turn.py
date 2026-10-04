"""ICE server configuration for peer-to-peer file share.

Peers learn their ICE servers from the signalling socket rather than from a list
baked into the frontend, so TURN credentials can be short-lived and the relay can
change without a deploy of every client.

STUN only finds a path when one exists. It does not on networks that isolate
clients from each other (office/hotel/campus Wi-Fi), lack NAT hairpinning (two
devices behind the same router), or allow nothing out but 80/443. TURN relays
the bytes for exactly those cases, and ICE only selects a relay candidate when
no direct pair works, so a healthy network still transfers device to device.

Credentials come from Cloudflare Realtime. One set is minted and shared until
it is half-way to expiry: at most one Cloudflare call per few hours, instead of
one per transfer on the path of every connection.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

# Always offered. Two providers so one being unreachable is not fatal, and
# Cloudflare's listens on the standard 3478 where Google's uses 19302 — some
# firewalls allow one and not the other.
STUN_SERVERS: list[dict] = [
    {"urls": ["stun:stun.cloudflare.com:3478"]},
    {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
]

_CF_URL = "https://rtc.live.cloudflare.com/v1/turn/keys/{key}/credentials/generate-ice-servers"

_cache: dict = {"servers": None, "expires_at": 0.0, "retry_after": 0.0}
_lock = asyncio.Lock()


def _usable_turn_urls(urls: list[str]) -> list[str]:
    # Cloudflare offers an alternate port 53, which browsers block outright;
    # it would only add a candidate that times out.
    return [u for u in urls if ":53?" not in u and not u.endswith(":53")]


async def _mint() -> list[dict] | None:
    s = get_settings()
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(
            _CF_URL.format(key=s.cf_turn_key_id),
            headers={"Authorization": f"Bearer {s.cf_turn_api_token}"},
            json={"ttl": s.cf_turn_credential_ttl_seconds},
        )
    if resp.status_code not in (200, 201):
        log.warning("TURN credential mint failed: %s %s", resp.status_code, resp.text[:200])
        return None
    servers = []
    for entry in resp.json().get("iceServers", []):
        urls = entry.get("urls")
        urls = [urls] if isinstance(urls, str) else list(urls or [])
        if not entry.get("username"):
            continue  # Cloudflare's STUN entry duplicates ours
        urls = _usable_turn_urls(urls)
        if urls:
            servers.append(
                {"urls": urls, "username": entry["username"], "credential": entry["credential"]}
            )
    return servers or None


async def get_ice_servers() -> list[dict]:
    """STUN always; TURN too when configured and Cloudflare answers.

    Never raises: a relay outage must degrade to STUN-only, which still works on
    most networks, rather than fail the connection outright.
    """
    s = get_settings()
    if not s.turn_configured:
        return STUN_SERVERS

    def cached() -> list[dict] | None:
        now = time.time()
        if _cache["servers"] and now < _cache["expires_at"]:
            return STUN_SERVERS + _cache["servers"]
        if not _cache["servers"] and now < _cache["retry_after"]:
            return STUN_SERVERS  # Cloudflare failed recently; don't hammer it
        return None

    if (hit := cached()) is not None:
        return hit

    async with _lock:
        if (hit := cached()) is not None:
            return hit
        try:
            turn = await _mint()
        except Exception as exc:  # network error, bad JSON
            log.warning("TURN credential mint errored: %s", exc)
            turn = None
        if turn:
            _cache["servers"] = turn
            # Refresh at half-life so every handed-out credential has at least
            # half its TTL left — enough to outlast the transfer it starts.
            _cache["expires_at"] = time.time() + s.cf_turn_credential_ttl_seconds / 2
            return STUN_SERVERS + turn
        _cache["servers"] = None
        _cache["retry_after"] = time.time() + 60
        return STUN_SERVERS


def turn_available() -> bool:
    return bool(_cache["servers"]) and time.time() < _cache["expires_at"]
