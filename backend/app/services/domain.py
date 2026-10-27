"""Custom domains — proving ownership, attaching them, and keeping them honest.

Two independent facts, tracked separately because they fail independently:

  * **ownership** — a `_markdrop-verify` TXT record proves the claimant controls
    DNS for the host. Nothing is served before this passes, or anyone could
    claim a host they don't own and have us route traffic for it.
  * **attachment** — the host is registered with the hosting project so TLS is
    issued and requests reach us at all.

And one that only time can show: **ownership is not forever**. A domain that was
verified last year may have been sold since, or its owner may have repointed it
at their own server. `services/domain_monitor.py` re-reads both records on a
schedule; a domain whose checks keep failing for the lapse window is *lapsed*:
detached, no longer resolved, given no tokens and no CORS.

Only a **live** domain (verified, attached, app kind where it matters) is ever
resolved for serving, minted a tenant token or granted CORS. `LIVE` is that
rule, in one place.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError, OperationFailure

from app.config import get_settings
from app.models.domain import Domain, DomainKind

settings = get_settings()
log = logging.getLogger(__name__)

TXT_PREFIX = "_markdrop-verify"
MAX_DOMAINS_PER_WORKSPACE = 25

# Hosts nobody may claim. Without this, registering `markdrop.in` would let a
# stranger scope our own traffic to their workspace and rebrand the product.
_RESERVED_SUFFIXES = ("markdrop.in", "workers.dev", "vercel.app", "localhost")

# The one definition of "this host may serve, receive tokens and get CORS".
LIVE: dict = {"status": "verified", "attached": True}


def _now() -> datetime:
    """The clock. A function so tests can move it (lapse needs days to pass)."""
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    """Mongo hands datetimes back naive (UTC); compare like with like."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _to_domain(raw: dict) -> Domain:
    return Domain(
        id=str(raw["_id"]),
        host=raw["host"],
        workspace_id=raw["workspace_id"],
        kind=raw["kind"],
        status=raw.get("status", "pending"),
        verification_token=raw["verification_token"],
        created_at=raw["created_at"],
        verified_at=raw.get("verified_at"),
        last_checked_at=raw.get("last_checked_at"),
        last_error=raw.get("last_error"),
        attached=bool(raw.get("attached")),
        is_primary=bool(raw.get("is_primary")),
        failures=int(raw.get("failures") or 0),
        first_failed_at=raw.get("first_failed_at"),
        lapsed_at=raw.get("lapsed_at"),
        routing_ok=raw.get("routing_ok"),
        expires_at=raw.get("expires_at"),
    )


def is_live(domain: Domain | dict | None) -> bool:
    """Verified and attached (and therefore not lapsed or pending)."""
    if domain is None:
        return False
    if isinstance(domain, dict):
        return domain.get("status") == "verified" and bool(domain.get("attached"))
    return domain.status == "verified" and domain.attached


def clean_host(raw: str | None) -> str:
    """Lenient normalisation for *lookups* (never raises): lowercase, no port,
    no trailing dot. `Docs.Acme.com.:443` and `docs.acme.com` are one host, and
    a lookup that disagreed with `normalize_host` about that would let the
    trailing-dot spelling slip past every check keyed on the host."""
    value = (raw or "").strip().lower()
    if "://" in value:
        value = urlparse(value).hostname or ""
    value = value.split("/")[0]
    if value.startswith("["):  # an IPv6 literal never names a domain of ours
        return ""
    return value.split(":")[0].rstrip(".")


def normalize_host(raw: str) -> str:
    """Reduce whatever was typed to a bare hostname, or reject it.

    People paste `https://cdn.acme.com/`, `CDN.Acme.com.`, and `cdn.acme.com:443`
    interchangeably. All three are the same host and must normalise to one
    string, or the unique index stops meaning anything.
    """
    value = (raw or "").strip().lower()
    if not value:
        raise HTTPException(status_code=422, detail="Enter a domain.")
    if "://" in value:
        value = urlparse(value).hostname or ""
    value = value.split("/")[0].split(":")[0].rstrip(".")
    if not value:
        raise HTTPException(status_code=422, detail="That doesn't look like a domain.")

    # An IP literal can't be DNS-verified and can't get a certificate.
    try:
        ipaddress.ip_address(value)
        raise HTTPException(status_code=422, detail="Use a domain name, not an IP address.")
    except ValueError:
        pass

    labels = value.split(".")
    if len(labels) < 2 or any(not lbl for lbl in labels):
        raise HTTPException(status_code=422, detail="Enter a full domain, like cdn.example.com.")
    if len(value) > 253:
        raise HTTPException(status_code=422, detail="That domain is too long.")
    for lbl in labels:
        if len(lbl) > 63 or not all(c.isalnum() or c == "-" for c in lbl):
            raise HTTPException(status_code=422, detail=f"'{lbl}' isn't a valid domain label.")
        if lbl.startswith("-") or lbl.endswith("-"):
            raise HTTPException(status_code=422, detail=f"'{lbl}' can't start or end with a hyphen.")

    for suffix in _RESERVED_SUFFIXES:
        if value == suffix or value.endswith("." + suffix):
            raise HTTPException(
                status_code=422,
                detail=f"{value} is reserved and can't be added as a custom domain.",
            )
    # Also refuse whatever this deployment is actually running on, which is not
    # necessarily markdrop.in — a self-hosted instance has its own hostnames.
    for configured in (settings.frontend_url, settings.artifact_origin, settings.api_base_url):
        host = (urlparse(configured).hostname or "").lower() if configured else ""
        if host and (value == host or value.endswith("." + host)):
            raise HTTPException(
                status_code=422,
                detail=f"{value} is reserved and can't be added as a custom domain.",
            )
    return value


# ── Apex detection ────────────────────────────────────────────────────────────

# Second-level registries where the registrable name has three labels. Not the
# Public Suffix List (no dependency for it here), so `apex_certain` says when the
# guess may be wrong and the UI shows both record types.
_CC_SLD = frozenset({"co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go", "ltd", "plc", "gen", "firm", "ind"})


def apex_guess(host: str) -> tuple[bool, bool]:
    """(is_apex, certain).

    `example.com` is an apex; `docs.example.com` is not; `example.co.uk` is an
    apex too, which the old "exactly one dot" rule got wrong (it told the
    customer to CNAME their apex, which most DNS panels refuse). Anything we
    can't be sure about is reported as uncertain, and both record types are
    offered.
    """
    labels = clean_host(host).split(".")
    if len(labels) <= 2:
        return True, True
    if len(labels) == 3 and len(labels[-1]) == 2 and labels[-2] in _CC_SLD:
        return True, False
    if len(labels) == 3 and len(labels[-1]) == 2 and len(labels[-2]) <= 3:
        # foo.xx.yy: may be a ccSLD we don't list, or a plain subdomain.
        return False, False
    return False, True


async def list_domains(db: AsyncIOMotorDatabase, workspace_id: str) -> list[Domain]:
    rows = await db["domains"].find({"workspace_id": workspace_id}).to_list(length=100)
    rows.sort(key=lambda r: r["created_at"])
    return [_to_domain(r) for r in rows]


def _pending_expiry(now: datetime) -> datetime:
    return now + timedelta(days=settings.domain_pending_ttl_days)


async def add_domain(
    db: AsyncIOMotorDatabase, workspace_id: str, raw_host: str, kind: DomainKind
) -> Domain:
    """Claim a host for this workspace (pending until its TXT record is seen).

    A pending claim no longer blocks anyone else: two workspaces may both be
    waiting on the same host, and the first to *verify* it wins (the partial
    unique index on verified rows makes that a guarantee; the losers' pending
    rows are removed on verify). Pending claims expire after
    `domain_pending_ttl_days`. Only a verified host is "already claimed".
    """
    host = normalize_host(raw_host)

    count = await db["domains"].count_documents({"workspace_id": workspace_id})
    if count >= MAX_DOMAINS_PER_WORKSPACE:
        raise HTTPException(
            status_code=429,
            detail=f"A workspace can hold at most {MAX_DOMAINS_PER_WORKSPACE} domains.",
        )

    if await db["domains"].find_one({"host": host, "workspace_id": workspace_id}, {"_id": 1}):
        raise HTTPException(status_code=409, detail=f"{host} is already in this workspace.")
    now = _now()
    grace = now - timedelta(days=settings.domain_pending_ttl_days)
    if await db["domains"].find_one(
        {"host": host, "$or": [
            {"status": "verified"},
            {"status": "lapsed", "lapsed_at": {"$gt": grace}},
        ]},
        {"_id": 1},
    ):
        # Deliberately vague: confirming *which* workspace holds it would leak
        # one customer's configuration to another. A recently lapsed row still
        # counts: its owner can bring it back with one check, and letting a
        # stranger race them for it the moment a DNS blip lapsed it would be a
        # takeover. After the grace period the host is open to whoever proves
        # ownership first (a sold domain must not stay stuck forever).
        raise HTTPException(status_code=409, detail=f"{host} is already claimed.")

    doc = {
        "host": host,
        "workspace_id": workspace_id,
        "kind": kind,
        "status": "pending",
        "verification_token": f"markdrop-verify={secrets.token_urlsafe(24)}",
        "created_at": now,
        "attached": False,
        "expires_at": _pending_expiry(now),
    }
    try:
        result = await db["domains"].insert_one(doc)
    except DuplicateKeyError:
        # Only reachable on a database still carrying the old all-rows unique
        # index (before ensure_indexes ran) or a concurrent double-submit.
        raise HTTPException(status_code=409, detail=f"{host} is already claimed.")
    doc["_id"] = result.inserted_id
    return _to_domain(doc)


async def detach_from_hosting(host: str) -> bool:
    """Release a host from the hosting project. Best effort, never raises.

    Forgetting this is worse than it looks: Vercel refuses to add a domain that
    is already on another project, so a host left attached after its Markdrop
    domain record is gone cannot be re-added by anyone -- including the customer
    who owns it. The record is being deleted either way, so a failure here must
    not block that; it just leaves a host to clean up by hand.
    """
    if not settings.vercel_domains_configured:
        # Nothing to detach from, which is the end state the caller wanted.
        # Reporting failure here would make `detach_domain` refuse to take a
        # host off the air on any deployment without hosting credentials.
        return True

    import httpx

    params = {}
    if settings.vercel_team_id:
        params["teamId"] = settings.vercel_team_id
    url = (
        f"https://api.vercel.com/v9/projects/{settings.vercel_project_id}"
        f"/domains/{host}"
    )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.delete(
                url, params=params,
                headers={"Authorization": f"Bearer {settings.vercel_api_token}"},
            )
        # 404 means it was never there, which is the state we wanted anyway.
        return resp.status_code in (200, 204, 404)
    except Exception:
        return False


async def remove_domain(db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str) -> None:
    raw = await _find(db, workspace_id, domain_id)
    if raw.get("attached"):
        await detach_from_hosting(raw["host"])
    await db["domains"].delete_one({"_id": raw["_id"]})


async def _find(db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str) -> dict:
    try:
        oid = ObjectId(domain_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Domain not found")
    raw = await db["domains"].find_one({"_id": oid, "workspace_id": workspace_id})
    if not raw:
        raise HTTPException(status_code=404, detail="Domain not found")
    return raw


# ── DNS checks ────────────────────────────────────────────────────────────────


def _flatten(rdata) -> str:
    """A TXT record arrives as one or more quoted strings that must be
    concatenated; long tokens get split at 255 bytes by many providers."""
    return "".join(
        part.decode() if isinstance(part, bytes) else str(part)
        for part in rdata.strings  # type: ignore[attr-defined]
    ).strip()


def _txt_values(host: str) -> list[str]:
    """Read the verification TXT record from the zone's own nameservers.

    Deliberately not the system resolver. Verification is always run moments
    after someone edits DNS, and a recursive resolver will happily serve the
    previous answer for the rest of its TTL — an hour is common. The customer
    then sees "that record doesn't match" immediately after correctly adding it,
    concludes they got it wrong, and starts changing things that were already
    right. Asking the authoritative servers removes the cache from the path.

    Falls back to the ordinary resolver if the authoritative lookup fails, so a
    zone we cannot introspect still verifies eventually rather than never.
    Raises dnspython's NXDOMAIN / NoAnswer when there is no record at all.
    """
    import dns.message
    import dns.name
    import dns.query
    import dns.rdatatype
    import dns.resolver

    name = f"{TXT_PREFIX}.{host}"
    resolver = dns.resolver.Resolver()
    resolver.lifetime = 5.0
    resolver.timeout = 5.0

    try:
        # zone_for_name walks up until it finds the zone actually holding this
        # name, so a record on a delegated subdomain is found where it lives.
        zone = dns.resolver.zone_for_name(dns.name.from_text(name), resolver=resolver)
        nameservers = resolver.resolve(zone, "NS")
        addresses: list[str] = []
        for ns in nameservers:
            try:
                addresses.extend(str(a) for a in resolver.resolve(str(ns.target), "A"))
            except Exception:
                continue

        query = dns.message.make_query(dns.name.from_text(name), dns.rdatatype.TXT)
        for address in addresses[:4]:  # a couple of tries is plenty; don't hang
            try:
                answer = dns.query.udp(query, address, timeout=4.0)
            except Exception:
                continue
            values = [
                _flatten(rdata)
                for rrset in answer.answer
                if rrset.rdtype == dns.rdatatype.TXT
                for rdata in rrset
            ]
            if values:
                return values
    except Exception:
        pass  # fall through to the cached path rather than failing outright

    return [_flatten(rdata) for rdata in resolver.resolve(name, "TXT")]


def _is_absent(exc: BaseException) -> bool:
    """A definitive "there is no such record" (as opposed to "couldn't ask")."""
    try:
        import dns.resolver

        return isinstance(exc, (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer))
    except Exception:  # pragma: no cover - dnspython is a dependency
        return False


def check_txt(host: str, token: str) -> tuple[str, str | None]:
    """("ok" | "missing" | "error", message). Synchronous: run in a threadpool.

    "missing" is an answer (the record is gone or wrong) and may drop a domain
    out of `verified`; "error" is a failure to ask (timeout, SERVFAIL) and never
    does on its own — only a run of them spanning the lapse window.
    """
    try:
        values = _txt_values(host)
    except Exception as exc:
        if _is_absent(exc):
            return "missing", f"There is no TXT record at {TXT_PREFIX}.{host}."
        return "error", (
            f"Couldn't read {TXT_PREFIX}.{host} ({type(exc).__name__}). "
            "DNS changes can take a few minutes to propagate."
        )
    if token in values:
        return "ok", None
    return "missing", (
        f"Found {len(values)} TXT record(s) at {TXT_PREFIX}.{host}, "
        "but none matched the expected value."
    )


_VERCEL_CNAME = re.compile(r"(^|\.)vercel-dns(-\d+)?\.com$")


def _resolve_routing(host: str) -> tuple[list[str], list[str]]:
    """(CNAME chain, A addresses) for `host`. Raises on a lookup failure;
    returns empty lists when the name has no such records."""
    import dns.rdatatype
    import dns.resolver

    resolver = dns.resolver.Resolver()
    resolver.lifetime = 5.0
    resolver.timeout = 5.0
    try:
        answer = resolver.resolve(host, "A")
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        return [], []
    cnames: list[str] = []
    addrs: list[str] = []
    for rrset in answer.response.answer:
        if rrset.rdtype == dns.rdatatype.CNAME:
            cnames.extend(str(r.target).rstrip(".").lower() for r in rrset)
        elif rrset.rdtype == dns.rdatatype.A:
            addrs.extend(r.address for r in rrset)
    return cnames, addrs


def _target_addresses() -> list[str]:
    try:
        _, addrs = _resolve_routing(settings.custom_domain_cname_target.rstrip("."))
        return addrs
    except Exception:
        return []


def check_routing(host: str) -> tuple[str, str | None]:
    """Does this host still point at us? ("ok" | "missing" | "error", message).

    Accepted: a CNAME (anywhere in the chain) to the configured edge target, the
    apex A address, or A records shared with the edge target (an ALIAS/ANAME or
    flattened CNAME at the apex resolves to the target's addresses).
    """
    target = settings.custom_domain_cname_target.rstrip(".").lower()
    try:
        cnames, addrs = _resolve_routing(host)
    except Exception as exc:
        return "error", f"Couldn't look up {host} ({type(exc).__name__})."
    if target in cnames:
        return "ok", None
    if _VERCEL_CNAME.search(target) and any(_VERCEL_CNAME.search(c) for c in cnames):
        return "ok", None
    if settings.custom_domain_apex_ip and settings.custom_domain_apex_ip in addrs:
        return "ok", None
    if addrs and set(addrs) & set(_target_addresses()):
        return "ok", None
    if not cnames and not addrs:
        return "missing", f"{host} has no CNAME or A record pointing at {target}."
    seen = cnames[0] if cnames else ", ".join(addrs[:3])
    return "missing", f"{host} points at {seen}, not {target}."


async def _run(fn, *args):
    from starlette.concurrency import run_in_threadpool

    return await run_in_threadpool(fn, *args)


# ── Attachment ────────────────────────────────────────────────────────────────


class AttachUnavailable(RuntimeError):
    """Raised when attachment is requested but no hosting credentials exist."""


async def _vercel_attach(host: str) -> tuple[bool, str | None]:
    """Add the host to the hosting project. (ok, error detail)."""
    import httpx

    params = {}
    if settings.vercel_team_id:
        # Only when set: an empty teamId is not the same as omitting it.
        params["teamId"] = settings.vercel_team_id
    url = f"https://api.vercel.com/v10/projects/{settings.vercel_project_id}/domains"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                url,
                params=params,
                headers={"Authorization": f"Bearer {settings.vercel_api_token}"},
                json={"name": host},
            )
    except Exception as exc:
        return False, f"Couldn't reach the hosting provider ({type(exc).__name__})."
    # 409 means the host is already on the project — the desired end state.
    if resp.status_code in (200, 201, 409):
        return True, None
    # Surface the host's own words — "domain is already in use by another
    # project" is far more actionable than a generic failure.
    try:
        detail = resp.json().get("error", {}).get("message") or resp.text[:200]
    except Exception:
        detail = resp.text[:200]
    return False, detail


async def _ensure_attached(db: AsyncIOMotorDatabase, raw: dict, routing_state: str | None) -> None:
    """Bring a verified host on the air, if it isn't already.

    With hosting credentials: attach it now (the stepper's "auto-attach").
    Without them an operator adds the host to the project by hand, and the
    routing record pointing at the edge is the best evidence we have that they
    did; treat that as attached so a self-hosted deployment still goes live.
    """
    if raw.get("attached") or raw.get("status") != "verified":
        return
    now = _now()
    if settings.vercel_domains_configured:
        ok, detail = await _vercel_attach(raw["host"])
        updates = (
            {"attached": True, "attached_via": "vercel", "last_error": None}
            if ok else {"last_error": f"Hosting provider refused the domain: {detail}"}
        )
    elif routing_state == "ok":
        updates = {"attached": True, "attached_via": "dns"}
    else:
        return
    updates["last_checked_at"] = now
    await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)


async def attach_to_hosting(db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str) -> Domain:
    """Register a verified host with the hosting project so TLS is issued.

    Ownership first, always. Attaching an unverified host would let anyone point
    a hostname they don't control at us and have a certificate issued for it.
    """
    raw = await _find(db, workspace_id, domain_id)
    if raw.get("status") != "verified":
        raise HTTPException(
            status_code=409,
            detail="Prove ownership first — the DNS record has to be visible before "
            "the domain can be attached.",
        )
    if not settings.vercel_domains_configured:
        raise AttachUnavailable(
            "No hosting credentials are configured, so this domain has to be attached by hand."
        )
    ok, detail = await _vercel_attach(raw["host"])
    now = _now()
    if ok:
        updates = {"attached": True, "attached_via": "vercel", "last_error": None, "last_checked_at": now}
        await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
        raw.update(updates)
        return _to_domain(raw)
    await db["domains"].update_one(
        {"_id": raw["_id"]}, {"$set": {"last_error": detail, "last_checked_at": now}}
    )
    raise HTTPException(status_code=502, detail=f"Hosting provider refused the domain: {detail}")


async def detach_domain(db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str) -> Domain:
    """Stop serving a host, without forgetting it.

    The counterpart to `attach_to_hosting`, and the reason it exists separately
    from `remove_domain`: taking a domain off the air is routine and reversible,
    while removing it discards a verification that took DNS propagation to earn.
    Detaching keeps the record and its `verified` status, so re-attaching later
    is one click rather than another round of DNS.

    The hosting call is best effort. If it fails we leave `attached` alone rather
    than claiming a detach that did not happen -- a record saying "not attached"
    while the host still resolves to us is the worst of both.
    """
    raw = await _find(db, workspace_id, domain_id)
    if not raw.get("attached"):
        return _to_domain(raw)  # already off the air; nothing to undo

    if not await detach_from_hosting(raw["host"]):
        raise HTTPException(
            status_code=502,
            detail="Couldn't take that domain off the hosting project. Try again in a moment.",
        )

    now = _now()
    await db["domains"].update_one(
        {"_id": raw["_id"]}, {"$set": {"attached": False, "last_error": None, "last_checked_at": now}}
    )
    raw.update(attached=False, last_error=None, last_checked_at=now)
    return _to_domain(raw)


# ── Lifecycle ─────────────────────────────────────────────────────────────────


_HEALTHY = {"failures": 0, "first_failed_at": None, "lapsed_at": None, "last_error": None}


async def _promote(db: AsyncIOMotorDatabase, raw: dict, now: datetime) -> None:
    """pending/lapsed → verified. First to verify a host wins.

    The partial unique index on verified rows makes the race a guarantee: the
    second verifier's update raises DuplicateKeyError, answered as 409. The
    winner then removes everyone else's pending claim on the host, which would
    otherwise sit there telling another customer to keep trying.
    """
    updates = {
        "status": "verified",
        "verified_at": raw.get("verified_at") or now,
        "last_checked_at": now,
        **_HEALTHY,
    }
    try:
        await db["domains"].update_one(
            {"_id": raw["_id"]}, {"$set": updates, "$unset": {"expires_at": ""}}
        )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=f"{raw['host']} is already claimed.")
    raw.update(updates)
    raw.pop("expires_at", None)
    await db["domains"].delete_many(
        {"host": raw["host"], "_id": {"$ne": raw["_id"]}, "status": {"$ne": "verified"}}
    )
    # The first live document domain becomes the workspace's address on its own:
    # a workspace with one domain should never have to pick it.
    if raw.get("kind") == "app" and not raw.get("is_primary"):
        has_primary = await db["domains"].find_one(
            {"workspace_id": raw["workspace_id"], "is_primary": True, "status": "verified",
             "_id": {"$ne": raw["_id"]}},
            {"_id": 1},
        )
        if not has_primary:
            await db["domains"].update_one({"_id": raw["_id"]}, {"$set": {"is_primary": True}})
            raw["is_primary"] = True


async def _unverify(db: AsyncIOMotorDatabase, raw: dict, now: datetime, reason: str) -> None:
    """verified → pending: the TXT record is definitively gone.

    The domain stops serving at once and becomes an ordinary (expiring) claim
    again, which anyone who can prove ownership may now win.
    """
    if raw.get("attached"):
        await detach_from_hosting(raw["host"])
    updates = {
        "status": "pending", "attached": False, "is_primary": False,
        "last_error": reason, "last_checked_at": now, "expires_at": _pending_expiry(now),
        "failures": 0, "first_failed_at": None,
    }
    await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)


async def lapse(db: AsyncIOMotorDatabase, raw: dict, now: datetime, reason: str) -> None:
    """Take a domain whose DNS stopped proving it off the air.

    Detached from hosting (best effort: if the provider refuses, `attached`
    stays true and the next pass retries), never resolved again until an admin
    checks it and both records are back.
    """
    # Not primary any more: the workspace's address must be a host that answers.
    # It is chosen again automatically if it comes back and no other was.
    updates: dict = {"status": "lapsed", "lapsed_at": now, "last_checked_at": now,
                     "last_error": reason, "is_primary": False}
    if raw.get("attached"):
        if await detach_from_hosting(raw["host"]):
            updates["attached"] = False
    await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)
    log.warning("domain %s lapsed: %s", raw["host"], reason)


async def verify_domain(db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str) -> Domain:
    """"Check DNS again": re-read the TXT and routing records now.

    * pending → verified when the TXT record matches (then auto-attach, and
      primary if the workspace has none).
    * verified → pending when the TXT record is definitively gone or wrong
      (a lookup *failure* keeps it verified; the scheduled re-check decides
      about those).
    * lapsed → verified only when both records are back.
    """
    raw = await _find(db, workspace_id, domain_id)
    now = _now()
    txt, txt_msg = await _run(check_txt, raw["host"], raw["verification_token"])
    routing, routing_msg = await _run(check_routing, raw["host"])
    status = raw.get("status", "pending")
    routing_ok = routing == "ok" if routing != "error" else raw.get("routing_ok")

    if status == "verified":
        if txt == "missing":
            await _unverify(db, raw, now, txt_msg or "The verification record is gone.")
            return _to_domain(raw)
        updates = {"last_checked_at": now, "routing_ok": routing_ok,
                   "last_error": txt_msg or (routing_msg if routing != "ok" else None)}
        if txt == "ok" and routing == "ok":
            updates.update(_HEALTHY)
        await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
        raw.update(updates)
        await _ensure_attached(db, raw, routing)
        return _to_domain(raw)

    if txt == "ok" and (status != "lapsed" or routing == "ok"):
        raw["routing_ok"] = routing_ok
        await _promote(db, raw, now)
        await db["domains"].update_one({"_id": raw["_id"]}, {"$set": {
            "routing_ok": routing_ok,
            "last_error": routing_msg if routing != "ok" else None,
        }})
        raw["last_error"] = routing_msg if routing != "ok" else None
        await _ensure_attached(db, raw, routing)
        return _to_domain(raw)

    updates = {"last_checked_at": now, "routing_ok": routing_ok,
               "last_error": txt_msg or routing_msg}
    await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)
    return _to_domain(raw)


async def recheck(db: AsyncIOMotorDatabase, raw: dict, now: datetime | None = None) -> str:
    """One scheduled re-check of a verified (or lapsed-but-still-attached)
    domain. Returns what happened: "ok", "failing", "lapsed", "unverified",
    "detached"."""
    now = now or _now()
    status = raw.get("status")
    if status == "lapsed":
        # Lapsed earlier but the provider refused the detach: retry it.
        if raw.get("attached") and await detach_from_hosting(raw["host"]):
            await db["domains"].update_one({"_id": raw["_id"]}, {"$set": {"attached": False}})
            return "detached"
        return "lapsed"
    if status != "verified":
        return "skipped"

    txt, txt_msg = await _run(check_txt, raw["host"], raw["verification_token"])
    routing, routing_msg = await _run(check_routing, raw["host"])

    if txt == "ok" and routing == "ok":
        updates = {"last_checked_at": now, "routing_ok": True, **_HEALTHY}
        await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
        raw.update(updates)
        await _ensure_attached(db, raw, routing)
        return "ok"

    first = _aware(raw.get("first_failed_at")) or now
    failures = int(raw.get("failures") or 0) + 1
    reason = txt_msg if txt != "ok" else routing_msg
    if now - first >= timedelta(hours=settings.domain_lapse_after_hours):
        raw.update(failures=failures, first_failed_at=first)
        await db["domains"].update_one({"_id": raw["_id"]}, {"$set": {
            "failures": failures, "first_failed_at": first,
            "routing_ok": routing == "ok" if routing != "error" else raw.get("routing_ok"),
        }})
        await lapse(db, raw, now, reason or "DNS checks kept failing.")
        return "lapsed"
    updates = {
        "last_checked_at": now, "failures": failures, "first_failed_at": first,
        "last_error": reason,
        "routing_ok": routing == "ok" if routing != "error" else raw.get("routing_ok"),
    }
    await db["domains"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)
    return "failing"


# ── Resolution (what the edge asks on every request) ──────────────────────────


async def primary_host(db: AsyncIOMotorDatabase, workspace_id: str) -> str | None:
    """The host a workspace is addressed by: its chosen *live* document domain,
    else its oldest live one. `cdn` hosts are excluded — a card links to a
    page, and a cdn host has no pages — and so is anything not live: a URL on a
    lapsed or unattached host doesn't answer."""
    rows = (
        await db["domains"]
        .find({"workspace_id": workspace_id, **LIVE, "kind": "app"})
        .to_list(length=25)
    )
    if not rows:
        return None
    # An explicit choice wins. Oldest-first is only the fallback, for the
    # workspaces that have never made one — including every workspace that
    # existed before this was choosable.
    chosen = next((r for r in rows if r.get("is_primary")), None)
    if chosen:
        return chosen["host"]
    rows.sort(key=lambda r: r["created_at"])
    return rows[0]["host"]


async def set_primary(
    db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str
) -> None:
    """Choose which verified domain a workspace is addressed by.

    Only a verified `app` domain can be it: an unverified host serves nothing,
    and a `cdn` host has no pages, so printing either on a preview card would
    advertise an address that does not answer.
    """
    raw = await _find(db, workspace_id, domain_id)
    if raw.get("status") != "verified" or raw.get("kind") != "app":
        raise HTTPException(
            status_code=422,
            detail="Only a verified document domain can be the primary one.",
        )
    # Exactly one at a time: clear the rest first, so a failure between the two
    # writes leaves none chosen (and the oldest-first fallback still answers)
    # rather than two claiming it.
    await db["domains"].update_many(
        {"workspace_id": workspace_id, "is_primary": True}, {"$set": {"is_primary": False}}
    )
    await db["domains"].update_one({"_id": raw["_id"]}, {"$set": {"is_primary": True}})


async def host_belongs_to(
    db: AsyncIOMotorDatabase, workspace_id: str, host: str
) -> bool:
    """Is this a live document domain of this workspace?

    Used to decide whether a caller-supplied host may be printed on a preview
    card. Without the check, the host is attacker-chosen text rendered into an
    image we serve — an open invitation to put somebody else's brand on it.
    """
    host = clean_host(host)
    if not host:
        return False
    return bool(await db["domains"].find_one(
        {"workspace_id": workspace_id, "host": host, **LIVE, "kind": "app"},
        {"_id": 1},
    ))


async def resolve_host(db: AsyncIOMotorDatabase, raw_host: str) -> Domain | None:
    """Which workspace, if any, owns this host. Only ever returns a *live*
    domain (verified, attached, not lapsed): anything else must not influence
    what anyone is served, receive a token, or be granted CORS."""
    host = clean_host(raw_host)
    if not host:
        return None
    raw = await db["domains"].find_one({"host": host, **LIVE})
    return _to_domain(raw) if raw else None


# ── Indexes and migration ─────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    """Domain indexes, migrated safely from the old all-rows unique index.

    Order matters, and every step is idempotent:

    1. Create the partial unique index on *verified* rows first, so there is
       never a moment with no uniqueness guarantee at all. It cannot fail on
       existing data (the old index made every host unique), but if it ever
       does — duplicates left by a half-run migration — the extra verified rows
       are demoted to pending (oldest verification kept) and it is retried.
    2. Drop the old unique `host_1`, which made a pending claim block everyone.
    3. Recreate `host_1` as a plain lookup index.
    4. Pending rows expire (TTL on `expires_at`); rows from before expiry get
       one now, a full TTL from today rather than from their creation.
    5. Legacy verified rows that were never marked attached are marked attached
       (`attached_via: "legacy"`): before lifecycle checks existed, "verified"
       was what served, and they are live today. The scheduled re-check lapses
       any whose DNS no longer points here.
    """
    coll = db["domains"]
    try:
        if "host_verified_unique" not in await coll.index_information():
            await coll.create_index(
                "host", unique=True, name="host_verified_unique",
                partialFilterExpression={"status": "verified"},
            )
    except DuplicateKeyError:
        await _demote_duplicate_verified(db)
        await coll.create_index(
            "host", unique=True, name="host_verified_unique",
            partialFilterExpression={"status": "verified"},
        )
    except OperationFailure as exc:
        if getattr(exc, "code", None) == 11000:
            await _demote_duplicate_verified(db)
            await coll.create_index(
                "host", unique=True, name="host_verified_unique",
                partialFilterExpression={"status": "verified"},
            )
        else:
            raise

    info = await coll.index_information()
    old = info.get("host_1")
    if old and old.get("unique"):
        await coll.drop_index("host_1")
    await coll.create_index("host", name="host_1")
    await coll.create_index("workspace_id")
    await coll.create_index("expires_at", expireAfterSeconds=0, sparse=True)
    await coll.create_index([("status", 1), ("last_checked_at", 1)])
    # "Continue to <host> as you?" answered yes, per reader per host
    # (routers/auth.py tenant-token consent).
    await db["tenant_consents"].create_index([("user_id", 1), ("host", 1)], unique=True)

    # Steps 4 and 5 run once per database (a marker row), so a domain verified
    # *after* the migration without being attached is never mistaken for a
    # legacy one on the next restart.
    marker = {"_id": "domains-v2-lifecycle"}
    if await db["migrations"].find_one(marker):
        return
    now = _now()
    await coll.update_many(
        {"status": {"$nin": ["verified", "lapsed"]}, "expires_at": {"$exists": False}},
        {"$set": {"expires_at": _pending_expiry(now)}},
    )
    await coll.update_many(
        {"status": "verified", "attached": {"$ne": True}},
        {"$set": {"attached": True, "attached_via": "legacy"}},
    )
    try:
        await db["migrations"].insert_one({**marker, "at": now})
    except DuplicateKeyError:
        pass  # another worker finished it first


async def _demote_duplicate_verified(db: AsyncIOMotorDatabase) -> None:
    rows = await db["domains"].find({"status": "verified"}).to_list(length=None)
    by_host: dict[str, list[dict]] = {}
    for r in rows:
        by_host.setdefault(r["host"], []).append(r)
    for dupes in by_host.values():
        if len(dupes) < 2:
            continue
        dupes.sort(key=lambda r: (_aware(r.get("verified_at")) or _aware(r["created_at"])))
        for loser in dupes[1:]:
            await db["domains"].update_one(
                {"_id": loser["_id"]},
                {"$set": {"status": "pending", "attached": False, "is_primary": False,
                          "last_error": "Another workspace verified this host first."}},
            )
