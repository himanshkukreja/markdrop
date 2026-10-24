"""The OAuth 2.1 authorization server behind the MCP endpoint.

(`services/oauth.py` is the unrelated Google sign-in client.)

Who can get a token, and what it is good for:

* **Clients** are either registered dynamically (RFC 7591, `oauth_clients`) or
  identified by a Client ID Metadata Document URL (`services/cimd.py`).
* **Authorization requests** wait in `oauth_requests` (10 minutes) while the
  user decides on markdrop.in. Approving mints a one-time **code**
  (`oauth_codes`, 60 seconds, PKCE S256 bound) and records a **grant**
  (`oauth_grants`), which is what Settings → Connected apps lists.
* **Tokens** (`oauth_tokens`) are opaque random strings, stored only as SHA-256
  hashes. Access tokens (`mdat_`) live an hour and are audience-bound to the MCP
  resource; refresh tokens (`mdrt_`) rotate on every use and expire after 60
  days without one. Every token descends from one code and shares its
  `family_id`, so a replayed code or a replayed refresh token can revoke the
  whole line at once.

Nothing here accepts or mints a markdrop.in session; an access token is only
ever honoured by `/mcp`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.config import get_settings
from app.services import cimd

settings = get_settings()

ACCESS_PREFIX = "mdat_"
REFRESH_PREFIX = "mdrt_"
CLIENT_PREFIX = "mdc_"
SECRET_PREFIX = "mdcs_"

ACCESS_TTL = timedelta(hours=1)
REFRESH_TTL = timedelta(days=60)
CODE_TTL = timedelta(seconds=60)
# A used code is kept a little longer than it is valid, so that a replay can
# still be recognised (and its tokens revoked) instead of looking unknown.
CODE_PURGE_AFTER = timedelta(minutes=10)
REQUEST_TTL = timedelta(minutes=10)
ACCESS_CACHE_SECONDS = 30

SCOPES: dict[str, dict[str, str]] = {
    "documents:read": {
        "title": "Read your documents",
        "description": "See your documents and files: titles, contents, links and view counts.",
    },
    "documents:write": {
        "title": "Publish and change documents",
        "description": "Publish, update, change access to and delete documents and files for you.",
    },
}
SUPPORTED_SCOPES = list(SCOPES)
# Requested by some generic OAuth clients; refresh tokens are always issued, so
# it is accepted and dropped rather than failing the whole request.
IGNORED_SCOPES = frozenset({"offline_access"})

AUTH_METHODS = ("none", "client_secret_post", "client_secret_basic")
SECRET_METHODS = ("client_secret_post", "client_secret_basic")
GRANT_TYPES = ("authorization_code", "refresh_token")

_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})
# Never valid as a redirect: script/data URLs, and http to anything but loopback.
_DENIED_SCHEMES = frozenset({
    "javascript", "data", "file", "vbscript", "about", "blob", "ftp", "ws", "wss", "http",
})
_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*$")
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9\-._~]{43,128}$")
_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9\-_]{43}$")


class OAuthError(Exception):
    """An RFC 6749 error: `error` code, human description, HTTP status."""

    def __init__(self, error: str, description: str, status: int = 400):
        super().__init__(description)
        self.error = error
        self.description = description
        self.status = status

    def body(self) -> dict:
        return {"error": self.error, "error_description": self.description}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """Motor returns naive UTC datetimes; compare them as aware ones."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# ── Issuer, resource, scopes ──────────────────────────────────────────────────


def issuer() -> str:
    return settings.oauth_issuer_url


def resource() -> str:
    return settings.mcp_resource


def _normalize_resource(value: str) -> str | None:
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc or parts.query or parts.fragment:
        return None
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}{parts.path.rstrip('/')}"


def resource_matches(value: str | None) -> bool:
    """Whether a client-supplied `resource` names this MCP server: scheme and
    host compared case-insensitively, a trailing slash tolerated."""
    if not value:
        return False
    return _normalize_resource(value) == _normalize_resource(resource())


def parse_scopes(raw: str | None) -> list[str]:
    """Requested scopes, in canonical order. Empty means every scope."""
    items = [s for s in (raw or "").split() if s not in IGNORED_SCOPES]
    if not items:
        return list(SUPPORTED_SCOPES)
    unknown = [s for s in items if s not in SCOPES]
    if unknown:
        raise OAuthError("invalid_scope", f"Unknown scope: {unknown[0][:60]}")
    return [s for s in SUPPORTED_SCOPES if s in items]


def scope_details(scopes: list[str]) -> list[dict]:
    return [{"name": s, **SCOPES[s]} for s in scopes if s in SCOPES]


# ── Redirect URIs ─────────────────────────────────────────────────────────────


def redirect_uri_allowed(uri: str) -> bool:
    """May a client register this redirect URI?

    https anywhere; plain http only to a loopback host (native apps and CLIs
    listening on a local port); and private-use schemes (RFC 8252 §7.1) such as
    cursor://, which desktop apps use. Never a fragment, never credentials.
    """
    if not isinstance(uri, str) or not uri or len(uri) > 2000:
        return False
    try:
        parts = urlsplit(uri)
        parts.port  # noqa: B018 - raises on a malformed port
    except ValueError:
        return False
    scheme = parts.scheme.lower()
    if parts.fragment or parts.username is not None or parts.password is not None:
        return False
    if scheme == "https":
        return bool(parts.hostname)
    if scheme == "http":
        return (parts.hostname or "") in _LOOPBACK
    return bool(_SCHEME_RE.match(scheme)) and scheme not in _DENIED_SCHEMES and bool(
        parts.netloc or parts.path
    )


def redirect_uri_matches(registered: list[str], requested: str) -> bool:
    """Exact string match, except that a loopback http redirect may use any
    port (RFC 8252 §7.3): native clients pick a free port at run time."""
    if requested in registered:
        return True
    try:
        req = urlsplit(requested)
        req.port  # noqa: B018
    except ValueError:
        return False
    if req.scheme != "http" or (req.hostname or "") not in _LOOPBACK:
        return False
    if req.username is not None or req.password is not None or req.fragment:
        return False
    for candidate in registered:
        try:
            reg = urlsplit(candidate)
        except ValueError:
            continue
        if (
            reg.scheme == "http"
            and reg.hostname == req.hostname
            and (reg.path or "/") == (req.path or "/")
            and reg.query == req.query
        ):
            return True
    return False


def redirect_host(uri: str) -> str:
    """What the consent screen calls the place it sends people back to."""
    try:
        parts = urlsplit(uri)
    except ValueError:
        return uri[:80]
    return (parts.hostname or parts.netloc or parts.scheme)[:120]


def with_query(uri: str, params: dict) -> str:
    sep = "&" if "?" in uri else "?"
    return f"{uri}{sep}{urlencode({k: v for k, v in params.items() if v is not None})}"


# ── Clients ───────────────────────────────────────────────────────────────────


@dataclass
class Client:
    client_id: str
    name: str
    redirect_uris: list[str]
    auth_method: str = "none"
    secret_hash: str | None = None
    client_uri: str | None = None
    logo_uri: str | None = None
    verified_by: str = "registration"  # or "cimd"


async def get_client(db: AsyncIOMotorDatabase, client_id: str) -> Client | None:
    """Resolve a client_id. A metadata-document URL is fetched (and may raise
    `cimd.CIMDError`); anything else must be a registered client."""
    if not client_id or len(client_id) > 2048:
        return None
    if cimd.is_cimd_client_id(client_id):
        meta = await cimd.fetch_client(client_id)
        return Client(
            client_id=meta.client_id,
            name=meta.client_name,
            redirect_uris=meta.redirect_uris,
            auth_method="none",
            client_uri=meta.client_uri,
            logo_uri=meta.logo_uri,
            verified_by="cimd",
        )
    raw = await db["oauth_clients"].find_one({"_id": client_id})
    if not raw:
        return None
    return Client(
        client_id=raw["_id"],
        name=raw.get("client_name") or "Unnamed app",
        redirect_uris=raw.get("redirect_uris") or [],
        auth_method=raw.get("token_endpoint_auth_method") or "none",
        secret_hash=raw.get("client_secret_hash"),
        client_uri=raw.get("client_uri"),
        logo_uri=raw.get("logo_uri"),
        verified_by="registration",
    )


async def authenticate_client(
    db: AsyncIOMotorDatabase, client_id: str | None, client_secret: str | None
) -> Client:
    """The client making a token or revocation request.

    A metadata-document client is public and its tokens are bound to its URL,
    so the token endpoint never needs to fetch the document again.
    """
    if not client_id:
        raise OAuthError("invalid_client", "client_id is required.", 401)
    if cimd.is_cimd_client_id(client_id):
        return Client(client_id=client_id, name="", redirect_uris=[], verified_by="cimd")
    client = await get_client(db, client_id)
    if client is None:
        raise OAuthError("invalid_client", "Unknown client.", 401)
    if client.auth_method in SECRET_METHODS:
        if not client_secret or not client.secret_hash or not hmac.compare_digest(
            hash_token(client_secret), client.secret_hash
        ):
            raise OAuthError("invalid_client", "Client authentication failed.", 401)
    return client


def _https_or_none(value) -> str | None:
    """A display URL (client_uri, logo_uri) if it is https, else dropped: it is
    only ever shown on the consent screen, so a bad one isn't worth failing a
    registration over."""
    if isinstance(value, str) and value.startswith("https://") and len(value) <= 500:
        return value
    return None


async def register_client(db: AsyncIOMotorDatabase, body: dict) -> dict:
    """RFC 7591 dynamic registration. Returns the registration response.

    Redirect URIs and the token endpoint auth method are checked strictly; the
    rest is narrowed to what this server does (RFC 7591 §3.2.1 lets the server
    replace requested values), so a client listing an extra grant type still
    registers.
    """
    if not isinstance(body, dict):
        raise OAuthError("invalid_client_metadata", "Expected a JSON object.")
    uris = body.get("redirect_uris")
    if not isinstance(uris, list) or not uris or len(uris) > 10:
        raise OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs.")
    for uri in uris:
        if not redirect_uri_allowed(uri):
            raise OAuthError(
                "invalid_redirect_uri",
                "Redirect URIs must be https, http on a loopback address, or an app's own scheme.",
            )
    method = body.get("token_endpoint_auth_method") or "none"
    if method not in AUTH_METHODS:
        raise OAuthError("invalid_client_metadata", f"Unsupported token_endpoint_auth_method: {str(method)[:40]}")
    requested_grants = body.get("grant_types") or ["authorization_code", "refresh_token"]
    if not isinstance(requested_grants, list) or "authorization_code" not in requested_grants:
        raise OAuthError("invalid_client_metadata", "grant_types must include authorization_code.")
    grant_types = [g for g in GRANT_TYPES if g in requested_grants]
    response_types = body.get("response_types") or ["code"]
    if not isinstance(response_types, list) or "code" not in response_types:
        raise OAuthError("invalid_client_metadata", "Only the code response type is supported.")
    name = body.get("client_name")
    if name is not None and not isinstance(name, str):
        raise OAuthError("invalid_client_metadata", "client_name must be a string.")
    name = (name or "").strip()[:100] or "Unnamed app"
    client_uri = _https_or_none(body.get("client_uri"))
    logo_uri = _https_or_none(body.get("logo_uri"))
    # Informational only (the authorization request decides): echoed back when
    # it names scopes this server has, dropped otherwise.
    scope = body.get("scope")
    try:
        scope = " ".join(parse_scopes(scope)) if isinstance(scope, str) and scope.strip() else None
    except OAuthError:
        scope = None

    client_id = CLIENT_PREFIX + secrets.token_urlsafe(18)
    now = _now()
    issued_at = int(now.timestamp())
    secret = SECRET_PREFIX + secrets.token_urlsafe(32) if method in SECRET_METHODS else None
    record = {
        "_id": client_id,
        "client_name": name,
        "redirect_uris": list(uris),
        "grant_types": list(grant_types),
        "response_types": ["code"],
        "token_endpoint_auth_method": method,
        "client_secret_hash": hash_token(secret) if secret else None,
        "client_uri": client_uri,
        "logo_uri": logo_uri,
        "created_at": now,
    }
    await db["oauth_clients"].insert_one(record)
    out = {
        "client_id": client_id,
        "client_id_issued_at": issued_at,
        "client_name": name,
        "redirect_uris": list(uris),
        "grant_types": list(grant_types),
        "response_types": ["code"],
        "token_endpoint_auth_method": method,
    }
    if client_uri:
        out["client_uri"] = client_uri
    if logo_uri:
        out["logo_uri"] = logo_uri
    if scope:
        out["scope"] = scope
    if secret:
        out["client_secret"] = secret
        out["client_secret_expires_at"] = 0
    return out


# ── Authorization requests and codes ──────────────────────────────────────────


async def create_request(
    db: AsyncIOMotorDatabase,
    client: Client,
    *,
    redirect_uri: str,
    redirect_uri_explicit: bool,
    code_challenge: str,
    scopes: list[str],
    state: str | None,
) -> str:
    request_id = secrets.token_urlsafe(32)
    now = _now()
    await db["oauth_requests"].insert_one({
        "_id": request_id,
        "client_id": client.client_id,
        "client": {
            "name": client.name,
            "uri": client.client_uri,
            "logo_uri": client.logo_uri,
            "verified_by": client.verified_by,
        },
        "redirect_uri": redirect_uri,
        "redirect_uri_explicit": redirect_uri_explicit,
        "code_challenge": code_challenge,
        "scopes": scopes,
        "state": state,
        "resource": resource(),
        "created_at": now,
        "expires_at": now + REQUEST_TTL,
    })
    return request_id


async def get_request(db: AsyncIOMotorDatabase, request_id: str) -> dict | None:
    if not request_id or len(request_id) > 100:
        return None
    raw = await db["oauth_requests"].find_one({"_id": request_id})
    if not raw or _aware(raw.get("expires_at")) <= _now():
        return None
    return raw


async def take_request(db: AsyncIOMotorDatabase, request_id: str) -> dict | None:
    """Remove a pending request and return it: a request is decided once."""
    if not request_id or len(request_id) > 100:
        return None
    raw = await db["oauth_requests"].find_one_and_delete({"_id": request_id})
    if not raw or _aware(raw.get("expires_at")) <= _now():
        return None
    return raw


def request_summary(req: dict, user) -> dict:
    """The consent screen's view of a pending request."""
    client = req.get("client") or {}
    return {
        "client": {
            "name": client.get("name") or "Unnamed app",
            "uri": client.get("uri"),
            "logo_uri": client.get("logo_uri"),
            "redirect_host": redirect_host(req["redirect_uri"]),
            "verified_by": client.get("verified_by") or "registration",
        },
        "scopes": scope_details(req.get("scopes") or []),
        "account": {"email": user.email, "name": user.name},
        "resource": req.get("resource") or resource(),
    }


def error_redirect(redirect_uri: str, error: str, description: str | None, state: str | None) -> str:
    return with_query(redirect_uri, {
        "error": error, "error_description": description, "state": state, "iss": issuer(),
    })


async def approve(db: AsyncIOMotorDatabase, req: dict, user_id: str) -> str:
    """Mint the authorization code and record the grant; return the redirect."""
    code = secrets.token_urlsafe(32)
    now = _now()
    await db["oauth_codes"].insert_one({
        "_id": hash_token(code),
        "client_id": req["client_id"],
        "user_id": user_id,
        "redirect_uri": req["redirect_uri"],
        "redirect_uri_explicit": req.get("redirect_uri_explicit", True),
        "code_challenge": req["code_challenge"],
        "scopes": req["scopes"],
        "resource": req.get("resource") or resource(),
        "family_id": secrets.token_urlsafe(16),
        "created_at": now,
        "expires_at": now + CODE_TTL,
        "used_at": None,
        "purge_at": now + CODE_PURGE_AFTER,
    })
    client = req.get("client") or {}
    await db["oauth_grants"].update_one(
        {"user_id": user_id, "client_id": req["client_id"]},
        {
            "$set": {
                "scopes": req["scopes"],
                "client_name": client.get("name"),
                "client_uri": client.get("uri"),
                "logo_uri": client.get("logo_uri"),
                "verified_by": client.get("verified_by"),
                "approved_at": now,
            },
            "$setOnInsert": {"created_at": now, "last_used_at": None},
        },
        upsert=True,
    )
    return with_query(req["redirect_uri"], {"code": code, "state": req.get("state"), "iss": issuer()})


def deny(req: dict) -> str:
    return error_redirect(
        req["redirect_uri"], "access_denied", "The user declined.", req.get("state")
    )


def _pkce_ok(verifier: str | None, challenge: str) -> bool:
    if not verifier or not _VERIFIER_RE.match(verifier):
        return False
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    computed = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return hmac.compare_digest(computed, challenge)


def valid_code_challenge(challenge: str | None) -> bool:
    return bool(challenge) and bool(_CHALLENGE_RE.match(challenge))


# ── Tokens ────────────────────────────────────────────────────────────────────


async def _issue(
    db: AsyncIOMotorDatabase,
    *,
    user_id: str,
    client_id: str,
    scopes: list[str],
    family_id: str,
) -> dict:
    access = ACCESS_PREFIX + secrets.token_urlsafe(32)
    refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
    now = _now()
    base = {
        "user_id": user_id,
        "client_id": client_id,
        "scopes": scopes,
        "resource": resource(),
        "family_id": family_id,
        "created_at": now,
    }
    await db["oauth_tokens"].insert_many([
        {"_id": hash_token(access), "kind": "access", "expires_at": now + ACCESS_TTL, **base},
        {"_id": hash_token(refresh), "kind": "refresh", "expires_at": now + REFRESH_TTL,
         "rotated_at": None, **base},
    ])
    await touch_grant(db, user_id, client_id, force=True)
    return {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": int(ACCESS_TTL.total_seconds()),
        "refresh_token": refresh,
        "scope": " ".join(scopes),
    }


async def revoke_family(db: AsyncIOMotorDatabase, family_id: str) -> None:
    await db["oauth_tokens"].delete_many({"family_id": family_id})
    clear_access_cache()


async def exchange_code(
    db: AsyncIOMotorDatabase,
    client: Client,
    *,
    code: str | None,
    redirect_uri: str | None,
    code_verifier: str | None,
    resource_param: str | None,
) -> dict:
    if not code:
        raise OAuthError("invalid_request", "code is required.")
    now = _now()
    code_hash = hash_token(code)
    raw = await db["oauth_codes"].find_one_and_update(
        {"_id": code_hash, "used_at": None},
        {"$set": {"used_at": now}},
        return_document=ReturnDocument.BEFORE,
    )
    if raw is None:
        used = await db["oauth_codes"].find_one({"_id": code_hash})
        if used is not None:
            # A code presented twice was intercepted or replayed: whatever was
            # issued from it can no longer be trusted.
            await revoke_family(db, used["family_id"])
        raise OAuthError("invalid_grant", "The authorization code is invalid or was already used.")
    if _aware(raw["expires_at"]) <= now:
        raise OAuthError("invalid_grant", "The authorization code has expired.")
    if raw["client_id"] != client.client_id:
        raise OAuthError("invalid_grant", "The authorization code was issued to another client.")
    if redirect_uri is not None or raw.get("redirect_uri_explicit", True):
        if redirect_uri != raw["redirect_uri"]:
            raise OAuthError("invalid_grant", "redirect_uri does not match the authorization request.")
    if not _pkce_ok(code_verifier, raw["code_challenge"]):
        raise OAuthError("invalid_grant", "PKCE verification failed.")
    if resource_param is not None and not resource_matches(resource_param):
        raise OAuthError("invalid_target", "Unknown resource.")
    return await _issue(
        db, user_id=raw["user_id"], client_id=raw["client_id"],
        scopes=raw["scopes"], family_id=raw["family_id"],
    )


async def refresh(
    db: AsyncIOMotorDatabase,
    client: Client,
    *,
    refresh_token: str | None,
    scope: str | None,
    resource_param: str | None,
) -> dict:
    if not refresh_token:
        raise OAuthError("invalid_request", "refresh_token is required.")
    now = _now()
    token_hash = hash_token(refresh_token)
    raw = await db["oauth_tokens"].find_one({"_id": token_hash, "kind": "refresh"})
    if raw is None:
        raise OAuthError("invalid_grant", "The refresh token is invalid or was already used.")
    if raw["client_id"] != client.client_id:
        raise OAuthError("invalid_grant", "The refresh token was issued to another client.")
    if _aware(raw["expires_at"]) <= now:
        raise OAuthError("invalid_grant", "The refresh token has expired.")
    rotated = await db["oauth_tokens"].find_one_and_update(
        {"_id": token_hash, "kind": "refresh", "rotated_at": None},
        {"$set": {"rotated_at": now}},
    )
    if rotated is None:
        # Refresh tokens are single use. Seeing one again means two parties
        # hold it, and there is no telling which is the legitimate one.
        await revoke_family(db, raw["family_id"])
        raise OAuthError("invalid_grant", "The refresh token is invalid or was already used.")
    if resource_param is not None and not resource_matches(resource_param):
        raise OAuthError("invalid_target", "Unknown resource.")
    scopes = raw["scopes"]
    if scope:
        requested = parse_scopes(scope)
        if not set(requested) <= set(scopes):
            raise OAuthError("invalid_scope", "A refresh can't add scopes.")
        scopes = requested
    return await _issue(
        db, user_id=raw["user_id"], client_id=raw["client_id"],
        scopes=scopes, family_id=raw["family_id"],
    )


async def revoke(db: AsyncIOMotorDatabase, client: Client | None, token: str | None) -> None:
    """RFC 7009: revoke a token. Unknown tokens are not an error. With a
    client, only that client's tokens; without one, the bare holder of a token
    may give it up (holding it already allowed anything revoking could)."""
    if not token or len(token) > 200:
        return
    raw = await db["oauth_tokens"].find_one({"_id": hash_token(token)})
    if not raw or (client is not None and raw["client_id"] != client.client_id):
        return
    if raw["kind"] == "refresh":
        await revoke_family(db, raw["family_id"])
    else:
        await db["oauth_tokens"].delete_one({"_id": raw["_id"]})
        clear_access_cache()


# Validated access tokens, briefly, so a burst of tool calls is one lookup.
_access_cache: dict[str, tuple[float, dict]] = {}
_ACCESS_CACHE_MAX = 4096


def clear_access_cache() -> None:
    _access_cache.clear()


async def validate_access_token(db: AsyncIOMotorDatabase, raw_token: str) -> dict | None:
    """The stored record for a live `mdat_` token, else None."""
    if not raw_token.startswith(ACCESS_PREFIX) or len(raw_token) > 200:
        return None
    token_hash = hash_token(raw_token)
    mono = time.monotonic()
    hit = _access_cache.get(token_hash)
    if hit and hit[0] > mono and _aware(hit[1]["expires_at"]) > _now():
        return hit[1]
    record = await db["oauth_tokens"].find_one({"_id": token_hash, "kind": "access"})
    if not record or _aware(record["expires_at"]) <= _now():
        _access_cache.pop(token_hash, None)
        return None
    if len(_access_cache) >= _ACCESS_CACHE_MAX:
        _access_cache.clear()
    _access_cache[token_hash] = (mono + ACCESS_CACHE_SECONDS, record)
    await touch_grant(db, record["user_id"], record["client_id"])
    return record


# ── Grants (connected apps) ───────────────────────────────────────────────────


async def touch_grant(db: AsyncIOMotorDatabase, user_id: str, client_id: str, force: bool = False) -> None:
    """Move last_used_at forward, at most once a minute unless forced."""
    now = _now()
    query: dict = {"user_id": user_id, "client_id": client_id}
    if not force:
        query["$or"] = [{"last_used_at": None}, {"last_used_at": {"$lt": now - timedelta(minutes=1)}}]
    await db["oauth_grants"].update_one(query, {"$set": {"last_used_at": now}})


async def list_connections(db: AsyncIOMotorDatabase, user_id: str) -> list[dict]:
    rows = await db["oauth_grants"].find({"user_id": user_id}).sort("created_at", -1).to_list(length=200)
    return [
        {
            "client_id": r["client_id"],
            "name": r.get("client_name") or "Unnamed app",
            "logo_uri": r.get("logo_uri"),
            "uri": r.get("client_uri"),
            "scopes": r.get("scopes") or [],
            "connected_at": r.get("created_at"),
            "last_used_at": r.get("last_used_at"),
        }
        for r in rows
    ]


async def disconnect(db: AsyncIOMotorDatabase, user_id: str, client_id: str) -> bool:
    """Revoke every token, code and the grant this user gave this client."""
    grant = await db["oauth_grants"].delete_many({"user_id": user_id, "client_id": client_id})
    tokens = await db["oauth_tokens"].delete_many({"user_id": user_id, "client_id": client_id})
    await db["oauth_codes"].delete_many({"user_id": user_id, "client_id": client_id})
    clear_access_cache()
    return bool(grant.deleted_count or tokens.deleted_count)
