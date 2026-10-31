"""Who may read a password or members-only docs site, and how the edge learns it.

The docs edge (docs-platform/edge, a Cloudflare Worker over the docs R2 bucket)
serves every published site. For a site that isn't public it serves nothing but
a branded sign-in page until the reader's browser holds the edge's session
cookie for that site. This module is the API's half of that:

Policy. ``sites/<site>/access.json`` in the docs bucket is
``{"site", "level": "public"|"password"|"members", "policy_version": n}``. No
password, no hash: a reader never sees this object (the edge serves only what a
build manifest lists) and it holds nothing secret anyway. ``policy_version`` is
``access_version`` on the site row, bumped whenever the level or the password
changes, so every session cookie signed for the old policy stops working.
It is written by an ``access`` server job (queued on every change and on every
publish of a non-public site) and by the build runner itself before it flips a
site's pointer, so a private site is never live without its policy. Writers
never lower the version (the newest policy wins a race). No object = public:
every site published before this existed.

Sign-in. The password never reaches the edge. The sign-in page posts it straight
here (``POST /api/v1/docs-access/password``, rate limited per IP and site); a
members-only site sends the reader to markdrop.in, which asks here
(``POST /api/v1/docs-access/grant``) with the reader's session whether their
Docs Studio role on the site is at least viewer. Either way the answer is a
*grant*: a token signed with the secret the API shares with the edge
(``docs_access_secret`` = the Worker's ``DOCS_ACCESS_SECRET``), valid for two
minutes, for one site, one host, one policy version and one browser (the hash of
a random state the edge keeps in an HttpOnly cookie). It travels back in the
URL fragment of ``https://<host>/_access/callback`` (never sent to a server,
never logged); the edge checks it and sets its own 12-hour session cookie.

Token format (the edge's edge/access.mjs reads the same):
``base64url(JSON payload) "." base64url(HMAC-SHA256(secret, purpose "." payload_b64))``.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

log = logging.getLogger(__name__)

LEVELS = ("public", "password", "members")
GRANT_PURPOSE = "mdda-grant-v1"
SESSION_PURPOSE = "mdda-session-v1"
SECRET_MIN = 32
_STATE_HASH = re.compile(r"^[A-Za-z0-9_-]{43}$")


def policy_key(site_id: Any) -> str:
    return f"sites/{site_id}/access.json"


def level_of(site: dict) -> str:
    level = (((site.get("settings") or {}).get("access") or {}).get("level")) or "public"
    return level if level in LEVELS else "members"  # unknown → the strictest, never public


def version_of(site: dict) -> int:
    try:
        return max(0, int(site.get("access_version") or 0))
    except (TypeError, ValueError):
        return 0


def policy(site: dict) -> dict:
    """What the edge enforces for ``site`` right now (no secrets)."""
    return {"level": level_of(site), "policy_version": version_of(site)}


def is_public(site: dict) -> bool:
    return level_of(site) == "public"


def needs_policy(site: dict) -> bool:
    """Whether the edge must hold a policy object for this site (anything but a never-changed public site)."""
    return not is_public(site) or version_of(site) > 0


def access_changed(before: dict | None, after: dict | None) -> bool:
    """A change that must sign every reader out: the level, or the password (a new hash, even for
    the same password, since bcrypt salts every hash)."""
    a, b = (before or {}), (after or {})
    return (a.get("level") or "public") != (b.get("level") or "public") or a.get("password_hash") != b.get("password_hash")


# ── tokens ────────────────────────────────────────────────────────────────────


def secret() -> str | None:
    s = get_settings().docs_access_secret or ""
    return s if len(s) >= SECRET_MIN else None


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(purpose: str, payload: dict, key: str | None = None) -> str:
    key = key or secret()
    if not key:
        raise RuntimeError("docs_access_secret is not set")
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    mac = hmac.new(key.encode(), f"{purpose}.{body}".encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def read(purpose: str, token: str, key: str | None = None) -> dict | None:
    """The payload of a token this API (or the edge) signed for ``purpose``, if the MAC holds and it
    hasn't expired. Used by tests and to mirror the edge."""
    key = key or secret()
    if not key or not isinstance(token, str) or token.count(".") != 1:
        return None
    body, mac = token.split(".")
    want = hmac.new(key.encode(), f"{purpose}.{body}".encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(want, _unb64(mac)):
            return None
        data = json.loads(_unb64(body))
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("exp"), int) or data["exp"] <= time.time():
        return None
    return data


def valid_state_hash(sh: Any) -> bool:
    return isinstance(sh, str) and bool(_STATE_HASH.match(sh))


def mint_grant(site: dict, host: str, state_hash: str) -> str:
    """A two-minute grant for ``site`` on ``host`` at its current policy, bound to the browser whose
    edge state hashes to ``state_hash``."""
    p = policy(site)
    ttl = max(30, min(int(get_settings().docs_access_grant_ttl_seconds or 120), 600))
    return sign(GRANT_PURPOSE, {
        "s": str(site["_id"]), "h": host, "k": p["level"], "v": p["policy_version"], "sh": state_hash,
        "exp": int(time.time()) + ttl, "n": secrets.token_urlsafe(9),
    })


# ── addresses ─────────────────────────────────────────────────────────────────

_HOST = re.compile(r"^[a-z0-9.-]{1,253}(?::\d{1,5})?$")


def clean_host(host: Any) -> str | None:
    h = str(host or "").strip().lower().rstrip(".")
    return h if _HOST.match(h) and ".." not in h else None


def safe_next(path: Any) -> str:
    """A path on the site to land on after sign-in: same host only, never ``//evil`` or ``/\\evil``."""
    p = str(path or "/")
    if not p.startswith("/") or p.startswith("//") or p.startswith("/\\") or len(p) > 2000:
        return "/"
    if any(ord(c) < 0x20 or c == "\x7f" for c in p):
        return "/"
    return p


def site_hosts(site: dict) -> list[str]:
    from app.services import docs_snapshot

    return [h.lower() for h in docs_snapshot.site_hosts(site) if h]


def origin_of(host: str) -> str:
    """https, except a local development host (``*.localhost[:port]``)."""
    bare = host.split(":")[0]
    return f"http://{host}" if bare == "localhost" or bare.endswith(".localhost") else f"https://{host}"


def callback_url(host: str, grant: str, next_path: str) -> str:
    return f"{origin_of(host)}/_access/callback#g={quote(grant, safe='')}&next={quote(safe_next(next_path), safe='')}"


def gate_url(host: str, error: str, next_path: str) -> str:
    return f"{origin_of(host)}/_access/login?e={quote(error, safe='')}&next={quote(safe_next(next_path), safe='')}"


# ── the policy object (the docs bucket) ──────────────────────────────────────


def write_policy(store: Any, site: dict) -> dict:
    """Write ``site``'s current policy to the bucket (synchronous; run in a thread). Never lowers
    the version already there: a newer policy from another writer wins."""
    sid = str(site["_id"])
    want = {"site": sid, **policy(site)}
    raw = store.get_text(policy_key(sid))
    if raw:
        try:
            cur = json.loads(raw)
        except ValueError:
            cur = None
        if isinstance(cur, dict) and isinstance(cur.get("policy_version"), int):
            if cur["policy_version"] > want["policy_version"]:
                return {"written": False, "kept": {"level": cur.get("level"), "policy_version": cur["policy_version"]}}
            if cur["policy_version"] == want["policy_version"] and cur.get("level") == want["level"]:
                return {"written": False, **want}
    doc = {**want, "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    store.put_text(policy_key(sid), json.dumps(doc, separators=(",", ":")))
    return {"written": True, **want}


async def sync_policy(db: AsyncIOMotorDatabase, site_id: Any, *, store: Any = None) -> dict:
    """The ``access`` server job: the site's current policy → the bucket."""
    from app.services import docs_build
    from app.services.docs_jobs import SITES, oid

    site = await db[SITES].find_one({"_id": oid(site_id)}, {"settings.access.level": 1, "access_version": 1})
    if site is None:
        raise docs_build.RestoreError("site not found")
    store = store or docs_build.default_store()
    res = await asyncio.to_thread(write_policy, store, site)
    # The edge now holds this version (or a newer one): enforced.
    await mark_synced(db, site["_id"], version_of(site))
    return res


async def mark_synced(db: AsyncIOMotorDatabase, site_id: Any, version: int) -> None:
    """The edge holds the site's policy at ``version`` (``access_synced_version`` never goes down)."""
    from app.services.docs_jobs import SITES, oid

    await db[SITES].update_one({"_id": oid(site_id)}, {"$max": {"access_synced_version": int(version)}})


def enforced(site: dict) -> bool:
    """Whether the edge enforces the site's current policy (False while a change is still on its way:
    the access job writes it, and the sweeper retries until it does)."""
    if not needs_policy(site):
        return True
    try:
        synced = int(site.get("access_synced_version"))
    except (TypeError, ValueError):
        return False
    return synced >= version_of(site)


RETRY_AFTER_SECONDS = 60


async def requeue_unsynced(db: AsyncIOMotorDatabase) -> int:
    """The sweeper's pass (services/docs_dispatch.run_once): every site whose policy the edge doesn't
    hold yet (``access_version`` > ``access_synced_version``) gets its access job again, unless one is
    waiting or running, or one failed less than a minute ago. A private site never stays public for
    want of a retry."""
    from datetime import timedelta

    from app.services.docs_jobs import JOBS, SITES, now

    t = now()
    queued = 0
    rows = db[SITES].find({"deleted_at": None, "$or": [{"access_version": {"$gt": 0}},
                                                      {"settings.access.level": {"$nin": ["public", None]}}]},
                          {"settings.access.level": 1, "access_version": 1, "access_synced_version": 1})
    async for site in rows:
        if enforced(site):
            continue
        busy = await db[JOBS].find_one({"kind": "access", "site_id": site["_id"], "$or": [
            {"status": {"$in": ["queued", "running"]}},
            {"status": "failed", "updated_at": {"$gt": t - timedelta(seconds=RETRY_AFTER_SECONDS)}},
        ]}, {"_id": 1})
        if busy is None and await queue_sync(db, site["_id"], "retry") is not None:
            queued += 1
    return queued


async def queue_sync(db: AsyncIOMotorDatabase, site_id: Any, reason: str) -> dict | None:
    """Queue the ``access`` job (it runs inline in the API when this process holds the bucket keys,
    else on the local worker). Never fails the caller: the runner writes the policy too, and the
    sweeper (requeue_unsynced) queues it again until the edge holds the policy."""
    from app.services.docs_site_jobs import enqueue_job

    try:
        return await enqueue_job(db, "access", site_id, {"reason": reason})
    except Exception:  # pragma: no cover - a queue hiccup must not fail a settings save
        log.warning("docs site %s: couldn't queue the access sync", site_id, exc_info=True)
        return None


async def revoke_sessions(db: AsyncIOMotorDatabase, site_id: Any, reason: str) -> dict | None:
    """Sign every reader of a members-only site out at the edge: a new policy version (sessions are
    bound to it, docs-platform/edge/access.mjs sessionValid), written by the access job. For a
    member who lost access: their 12-hour session must not outlive it (the others sign in again,
    one click). None when the site isn't members-only (nothing to revoke)."""
    from app.services.docs_jobs import SITES, oid

    res = await db[SITES].update_one(
        {"_id": oid(site_id), "deleted_at": None, "settings.access.level": "members"},
        {"$inc": {"access_version": 1}, "$set": {"updated_at": datetime.now(timezone.utc)}})
    if res.modified_count != 1:
        return None
    return await queue_sync(db, site_id, reason)
