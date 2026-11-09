"""Web Push, the protocol (RFC 8030 delivery, RFC 8291 message encryption, RFC 8292 VAPID).

No library: cryptography (P-256, HKDF by hand, AES-128-GCM), PyJWT (the ES256 VAPID token) and
httpx. services/push.py decides who gets what; this module only builds and sends one message.

Keys (``MARKDROP_VAPID_*`` in backend/.env, never committed):

* ``vapid_private_key``: the P-256 private key as 32 raw bytes, base64url (what
  ``npx web-push generate-vapid-keys`` prints as "Private Key"), or a PEM.
* ``vapid_public_key``: the matching public key, 65 bytes uncompressed, base64url. Optional: it is
  derived from the private key when blank, and :func:`check_keys` refuses a pair that doesn't match.
* ``vapid_subject``: ``mailto:`` or ``https:`` contact the push services may use.

Generate a pair with ``python -m app.services.webpush keys`` (prints the three .env lines).

Every subscription endpoint is a URL the browser's push service gave it. The server POSTs to it,
so only the push services' own hosts are accepted (:func:`endpoint_allowed`): anything else could
point the API at an internal address.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import struct
import time
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlsplit

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import get_settings
from app.utils.http import shared_ssl

RECORD_SIZE = 4096
MAX_PAYLOAD = 3993  # 4096 - 16 (tag) - 1 (delimiter) - 86 (header); push services take up to 4096 bytes
JWT_TTL = 12 * 3600

# The push services browsers use: Chrome / Edge / Android / Samsung (FCM), Firefox (Mozilla autopush),
# Edge on Windows (WNS), Safari on macOS / iOS 16.4+ (Apple).
PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com",
              "web.push.apple.com")
PUSH_HOST_SUFFIXES = (".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com")


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: str) -> bytes:
    text = (text or "").strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ── Keys ──────────────────────────────────────────────────────────────────────


class VapidKeyError(ValueError):
    pass


def load_private_key(value: str) -> ec.EllipticCurvePrivateKey:
    value = (value or "").strip().replace("\\n", "\n")
    if not value:
        raise VapidKeyError("MARKDROP_VAPID_PRIVATE_KEY is empty")
    if "BEGIN" in value:
        key = serialization.load_pem_private_key(value.encode(), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
            raise VapidKeyError("MARKDROP_VAPID_PRIVATE_KEY must be a P-256 (prime256v1) key")
        return key
    try:
        raw = unb64u(value)
    except Exception as exc:
        raise VapidKeyError("MARKDROP_VAPID_PRIVATE_KEY isn't base64url") from exc
    if len(raw) != 32:
        raise VapidKeyError(f"MARKDROP_VAPID_PRIVATE_KEY must be 32 bytes (base64url, 43 characters); got {len(raw)}")
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def public_bytes(key: ec.EllipticCurvePrivateKey | ec.EllipticCurvePublicKey) -> bytes:
    pub = key.public_key() if isinstance(key, ec.EllipticCurvePrivateKey) else key
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def generate_keys() -> dict[str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    raw = key.private_numbers().private_value.to_bytes(32, "big")
    return {"private": b64u(raw), "public": b64u(public_bytes(key))}


@dataclass(frozen=True)
class Vapid:
    key: ec.EllipticCurvePrivateKey
    public: str  # base64url, 65 bytes uncompressed
    subject: str


def check_keys(settings=None) -> dict:
    """What a deploy can check before restarting: ``{configured, ok, public_key, problems}``.

    ``configured``: a private key is set. ``ok``: push can send (the key loads, the public key
    matches it, the subject is a mailto: or https: URL)."""
    s = settings or get_settings()
    problems: list[str] = []
    out = {"configured": bool((s.vapid_private_key or "").strip()), "ok": False, "public_key": None,
           "problems": problems}
    if not out["configured"]:
        if (s.vapid_public_key or "").strip():
            problems.append("MARKDROP_VAPID_PUBLIC_KEY is set but MARKDROP_VAPID_PRIVATE_KEY isn't")
        return out
    try:
        key = load_private_key(s.vapid_private_key)
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        problems.append(str(exc) or type(exc).__name__)
        return out
    derived = b64u(public_bytes(key))
    given = (s.vapid_public_key or "").strip()
    if given and given.rstrip("=") != derived:
        problems.append("MARKDROP_VAPID_PUBLIC_KEY doesn't match MARKDROP_VAPID_PRIVATE_KEY")
    subject = (s.vapid_subject or "").strip()
    if not (subject.startswith("mailto:") or subject.startswith("https://")):
        problems.append("MARKDROP_VAPID_SUBJECT must start with mailto: or https://")
    out["public_key"] = derived
    out["ok"] = not problems
    return out


@lru_cache(maxsize=4)
def _vapid_for(private: str, public: str, subject: str) -> Vapid | None:
    class _S:
        vapid_private_key, vapid_public_key, vapid_subject = private, public, subject

    if not check_keys(_S)["ok"]:
        return None
    key = load_private_key(private)
    return Vapid(key=key, public=b64u(public_bytes(key)), subject=subject.strip())


def vapid() -> Vapid | None:
    """The server's VAPID identity, or None when push isn't set up (or the keys are wrong)."""
    s = get_settings()
    return _vapid_for(s.vapid_private_key or "", s.vapid_public_key or "", s.vapid_subject or "")


def configured() -> bool:
    return vapid() is not None


# ── Endpoints ─────────────────────────────────────────────────────────────────


def _extra_hosts() -> set[str]:
    raw = get_settings().push_endpoint_hosts_extra or ""
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def endpoint_allowed(endpoint: str) -> bool:
    """A real push service's https URL (or, for tests and the e2e stack, a host listed in
    ``push_endpoint_hosts_extra``, where plain http is allowed)."""
    if not isinstance(endpoint, str) or len(endpoint) > 1024:
        return False
    try:
        parts = urlsplit(endpoint)
        host = (parts.hostname or "").lower()
        netloc = parts.netloc.lower()
    except ValueError:
        return False
    if not host or parts.username or parts.password:
        return False
    extra = _extra_hosts()
    if netloc in extra or host in extra:
        return parts.scheme in ("https", "http")
    if parts.scheme != "https" or parts.port not in (None, 443):
        return False
    return host in PUSH_HOSTS or any(host.endswith(sfx) for sfx in PUSH_HOST_SUFFIXES)


def audience(endpoint: str) -> str:
    p = urlsplit(endpoint)
    return f"{p.scheme}://{p.netloc}"


def vapid_header(endpoint: str, v: Vapid, now: float | None = None) -> str:
    claims = {"aud": audience(endpoint), "exp": int((now or time.time()) + JWT_TTL), "sub": v.subject}
    token = jwt.encode(claims, v.key, algorithm="ES256", headers={"typ": "JWT"})
    return f"vapid t={token}, k={v.public}"


# ── RFC 8291 ──────────────────────────────────────────────────────────────────


def _hmac(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


def encrypt(payload: bytes, ua_public: str | bytes, auth_secret: str | bytes, *, salt: bytes | None = None,
            server_key: ec.EllipticCurvePrivateKey | None = None) -> bytes:
    """The aes128gcm body for one subscription (one record). ``ua_public`` / ``auth_secret``: the
    subscription's ``keys.p256dh`` / ``keys.auth``. ``salt`` and ``server_key`` are fresh per
    message; tests pass them to check against RFC 8291's example."""
    ua_pub = unb64u(ua_public) if isinstance(ua_public, str) else ua_public
    auth = unb64u(auth_secret) if isinstance(auth_secret, str) else auth_secret
    if len(ua_pub) != 65 or ua_pub[0] != 4:
        raise ValueError("p256dh must be an uncompressed P-256 point")
    if len(auth) < 16:
        raise ValueError("auth must be 16 bytes")
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("payload too large")
    salt = salt or os.urandom(16)
    as_key = server_key or ec.generate_private_key(ec.SECP256R1())
    as_pub = public_bytes(as_key)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub)
    secret = as_key.exchange(ec.ECDH(), ua_key)
    prk_key = _hmac(auth, secret)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_pub + as_pub + b"\x01")
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack("!IB", RECORD_SIZE, len(as_pub)) + as_pub + body


def decrypt(message: bytes, ua_key: ec.EllipticCurvePrivateKey, auth_secret: bytes) -> bytes:
    """The browser's side (tests, and the e2e fake push service's twin in Node)."""
    salt, rs, idlen = message[:16], *struct.unpack("!IB", message[16:21])
    as_pub = message[21:21 + idlen]
    body = message[21 + idlen:]
    ua_pub = public_bytes(ua_key)
    secret = ua_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    prk_key = _hmac(auth_secret, secret)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_pub + as_pub + b"\x01")
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    plain = AESGCM(cek).decrypt(nonce, body, None).rstrip(b"\x00")
    if not plain.endswith(b"\x02"):
        raise ValueError("not a final record")
    return plain[:-1]


# ── Sending ───────────────────────────────────────────────────────────────────


# Tests replace this with an httpx.MockTransport (the fake push service); None: the network.
transport: httpx.AsyncBaseTransport | None = None


@dataclass
class Result:
    status: int  # 0: never reached the push service
    gone: bool = False  # the subscription is dead: forget it
    retry: bool = False  # try again later
    error: str | None = None


async def send(endpoint: str, p256dh: str, auth: str, payload: bytes, *, ttl: int = 24 * 3600,
               urgency: str = "normal", topic: str | None = None, client: httpx.AsyncClient | None = None) -> Result:
    v = vapid()
    if v is None:
        return Result(0, error="not_configured")
    if not endpoint_allowed(endpoint):
        return Result(0, gone=True, error="endpoint_not_allowed")
    if len(payload) > MAX_PAYLOAD:
        return Result(0, error="too_large")  # this message's fault, not the device's
    try:
        body = encrypt(payload, p256dh, auth)
    except ValueError as exc:
        return Result(0, gone=True, error=f"bad_keys: {exc}")
    headers = {"Authorization": vapid_header(endpoint, v), "TTL": str(int(ttl)), "Content-Encoding": "aes128gcm",
               "Content-Type": "application/octet-stream", "Urgency": urgency}
    if topic:
        headers["Topic"] = topic[:32]
    own = client is None
    c = client or httpx.AsyncClient(verify=shared_ssl(), timeout=10.0, follow_redirects=False, transport=transport)
    try:
        r = await c.post(endpoint, content=body, headers=headers)
    except httpx.HTTPError as exc:
        return Result(0, retry=True, error=type(exc).__name__)
    finally:
        if own:
            await c.aclose()
    if 200 <= r.status_code < 300:
        return Result(r.status_code)
    # 404 / 410: unsubscribed or expired. 403: signed with another key (the VAPID pair changed) — the
    # browser must subscribe again, so this one is dead too. 400 / 413: this message is wrong.
    if r.status_code in (404, 410, 403):
        return Result(r.status_code, gone=True, error=f"http_{r.status_code}")
    if r.status_code == 429 or r.status_code >= 500:
        return Result(r.status_code, retry=True, error=f"http_{r.status_code}")
    return Result(r.status_code, error=f"http_{r.status_code}")


def topic_for(key: str) -> str:
    """A Topic header (≤ 32 base64url characters) for ``key``: a newer message with the same topic
    replaces one the push service still holds for an offline device."""
    return b64u(hashlib.sha256(key.encode()).digest())[:32]


if __name__ == "__main__":  # python -m app.services.webpush keys
    import sys

    if sys.argv[1:] == ["keys"]:
        k = generate_keys()
        print(f"MARKDROP_VAPID_PUBLIC_KEY={k['public']}")
        print(f"MARKDROP_VAPID_PRIVATE_KEY={k['private']}")
        print("MARKDROP_VAPID_SUBJECT=https://markdrop.in")
    elif sys.argv[1:] == ["check"]:
        import json

        print(json.dumps(check_keys(), indent=2))
    else:
        print("usage: python -m app.services.webpush keys|check")
