"""Custom domains — proving ownership, then attaching them.

Two independent facts, tracked separately because they fail independently:

  * **ownership** — a `_markdrop-verify` TXT record proves the claimant controls
    DNS for the host. Nothing is served before this passes, or anyone could
    claim a host they don't own and have us route traffic for it.
  * **attachment** — the host is registered with the hosting project so TLS is
    issued and requests reach us at all.
"""

import ipaddress
import secrets
from datetime import datetime, timezone
from urllib.parse import urlparse

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.models.domain import Domain, DomainKind

settings = get_settings()

TXT_PREFIX = "_markdrop-verify"
MAX_DOMAINS_PER_WORKSPACE = 25

# Hosts nobody may claim. Without this, registering `markdrop.in` would let a
# stranger scope our own traffic to their workspace and rebrand the product.
_RESERVED_SUFFIXES = ("markdrop.in", "workers.dev", "vercel.app", "localhost")


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
    )


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


async def list_domains(db: AsyncIOMotorDatabase, workspace_id: str) -> list[Domain]:
    rows = await db["domains"].find({"workspace_id": workspace_id}).to_list(length=100)
    rows.sort(key=lambda r: r["created_at"])
    return [_to_domain(r) for r in rows]


async def add_domain(
    db: AsyncIOMotorDatabase, workspace_id: str, raw_host: str, kind: DomainKind
) -> Domain:
    host = normalize_host(raw_host)

    count = await db["domains"].count_documents({"workspace_id": workspace_id})
    if count >= MAX_DOMAINS_PER_WORKSPACE:
        raise HTTPException(
            status_code=429,
            detail=f"A workspace can hold at most {MAX_DOMAINS_PER_WORKSPACE} domains.",
        )

    existing = await db["domains"].find_one({"host": host})
    if existing:
        if existing["workspace_id"] == workspace_id:
            raise HTTPException(status_code=409, detail=f"{host} is already in this workspace.")
        # Deliberately vague: confirming *which* workspace holds it would leak
        # one customer's configuration to another.
        raise HTTPException(status_code=409, detail=f"{host} is already claimed.")

    now = datetime.now(timezone.utc)
    doc = {
        "host": host,
        "workspace_id": workspace_id,
        "kind": kind,
        "status": "pending",
        "verification_token": f"markdrop-verify={secrets.token_urlsafe(24)}",
        "created_at": now,
        "attached": False,
    }
    result = await db["domains"].insert_one(doc)
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
        return False

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
    try:
        oid = ObjectId(domain_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Domain not found")
    raw = await db["domains"].find_one({"_id": oid, "workspace_id": workspace_id})
    if not raw:
        raise HTTPException(status_code=404, detail="Domain not found")
    if raw.get("attached"):
        await detach_from_hosting(raw["host"])
    await db["domains"].delete_one({"_id": oid})


# ── Ownership ─────────────────────────────────────────────────────────────────


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


async def verify_domain(db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str) -> Domain:
    try:
        oid = ObjectId(domain_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Domain not found")
    raw = await db["domains"].find_one({"_id": oid, "workspace_id": workspace_id})
    if not raw:
        raise HTTPException(status_code=404, detail="Domain not found")

    domain = _to_domain(raw)
    now = datetime.now(timezone.utc)
    updates: dict = {"last_checked_at": now}

    from starlette.concurrency import run_in_threadpool

    try:
        values = await run_in_threadpool(_txt_values, domain.host)
    except Exception as exc:  # NXDOMAIN, timeout, no TXT record, SERVFAIL…
        updates.update(
            status="pending" if domain.status != "verified" else "verified",
            last_error=f"Couldn't read {TXT_PREFIX}.{domain.host} ({type(exc).__name__}). "
            "DNS changes can take a few minutes to propagate.",
        )
        await db["domains"].update_one({"_id": oid}, {"$set": updates})
        raw.update(updates)
        return _to_domain(raw)

    if domain.verification_token in values:
        updates.update(status="verified", verified_at=domain.verified_at or now, last_error=None)
    else:
        updates.update(
            status="pending" if domain.status != "verified" else "verified",
            last_error=(
                f"Found {len(values)} TXT record(s) at {TXT_PREFIX}.{domain.host}, "
                "but none matched the expected value."
            ),
        )
    await db["domains"].update_one({"_id": oid}, {"$set": updates})
    raw.update(updates)
    return _to_domain(raw)


# ── Attachment (telling the edge this host is ours to serve) ─────────────────


class AttachUnavailable(RuntimeError):
    """Raised when attachment is requested but no hosting credentials exist."""


async def attach_to_hosting(db: AsyncIOMotorDatabase, workspace_id: str, domain_id: str) -> Domain:
    """Register a verified host with the hosting project so TLS is issued.

    Ownership first, always. Attaching an unverified host would let anyone point
    a hostname they don't control at us and have a certificate issued for it.
    """
    try:
        oid = ObjectId(domain_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Domain not found")
    raw = await db["domains"].find_one({"_id": oid, "workspace_id": workspace_id})
    if not raw:
        raise HTTPException(status_code=404, detail="Domain not found")
    domain = _to_domain(raw)

    if domain.status != "verified":
        raise HTTPException(
            status_code=409,
            detail="Prove ownership first — the DNS record has to be visible before "
            "the domain can be attached.",
        )
    if not settings.vercel_domains_configured:
        raise AttachUnavailable(
            "No hosting credentials are configured, so this domain has to be attached by hand."
        )

    import httpx

    params = {}
    if settings.vercel_team_id:
        # Only when set: an empty teamId is not the same as omitting it.
        params["teamId"] = settings.vercel_team_id

    url = f"https://api.vercel.com/v10/projects/{settings.vercel_project_id}/domains"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            url,
            params=params,
            headers={"Authorization": f"Bearer {settings.vercel_api_token}"},
            json={"name": domain.host},
        )

    now = datetime.now(timezone.utc)
    # 409 means the host is already on the project — the desired end state, so
    # treat it as success rather than making the customer care about the retry.
    if resp.status_code in (200, 201) or resp.status_code == 409:
        await db["domains"].update_one(
            {"_id": oid}, {"$set": {"attached": True, "last_error": None, "last_checked_at": now}}
        )
        raw.update(attached=True, last_error=None, last_checked_at=now)
        return _to_domain(raw)

    # Surface the host's own words — "domain is already in use by another
    # project" is far more actionable than a generic failure.
    try:
        detail = resp.json().get("error", {}).get("message") or resp.text[:200]
    except Exception:
        detail = resp.text[:200]
    await db["domains"].update_one(
        {"_id": oid}, {"$set": {"last_error": detail, "last_checked_at": now}}
    )
    raise HTTPException(status_code=502, detail=f"Hosting provider refused the domain: {detail}")


# ── Resolution (what the edge asks on every request) ──────────────────────────


async def primary_host(db: AsyncIOMotorDatabase, workspace_id: str) -> str | None:
    """The host to print on a preview card: the workspace's oldest verified
    document domain. `cdn` hosts are excluded — a card links to a page, and a
    cdn host has no pages."""
    rows = (
        await db["domains"]
        .find({"workspace_id": workspace_id, "status": "verified", "kind": "app"})
        .to_list(length=25)
    )
    if not rows:
        return None
    rows.sort(key=lambda r: r["created_at"])
    return rows[0]["host"]


async def resolve_host(db: AsyncIOMotorDatabase, raw_host: str) -> Domain | None:
    """Which workspace, if any, owns this host. Only ever returns a *verified*
    domain: an unverified row must not influence what anyone is served."""
    host = (raw_host or "").strip().lower().split(":")[0].rstrip(".")
    if not host:
        return None
    raw = await db["domains"].find_one({"host": host, "status": "verified"})
    return _to_domain(raw) if raw else None
