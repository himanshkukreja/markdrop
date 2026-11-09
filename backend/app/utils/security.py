"""Secrets hashed with bcrypt: edit secrets, read passwords, login codes.

bcrypt is deliberately slow (~250 ms at the default cost on the API host), and the API serves every
request on one event loop: a ``checkpw`` called inline froze every other request — page reads, lock
heartbeats, the live socket — for that long, on *every* read of a password-protected document and
every save with an edit secret. So:

* ``check`` / ``hash_secret`` run bcrypt on a worker thread (the loop keeps serving meanwhile);
* ``check`` remembers a *successful* check for a while (in process, bounded), keyed by a SHA-256 of
  the hash and the secret together, so a reader re-reading a password-protected page, or an editor
  autosaving with an edit secret, pays for bcrypt once rather than on every request. A wrong secret
  is never remembered (each guess costs a full bcrypt, and password_attempts still counts it), and
  nothing in the cache can be turned back into the secret.
"""

import asyncio
import hashlib
import secrets
import time

import bcrypt

# sha256(hash \0 secret) -> expiry (monotonic). Successful checks only.
_OK: dict[bytes, float] = {}
_OK_TTL = 600.0
_OK_MAX = 4096


def _key(raw: str, hashed: str) -> bytes:
    return hashlib.sha256(hashed.encode() + b"\0" + raw.encode()).digest()


def check_sync(raw: str | None, hashed: str | None) -> bool:
    """bcrypt.checkpw, False for anything malformed. Blocking: use ``check`` from async code."""
    if not raw or not hashed:
        return False
    try:
        return bcrypt.checkpw(raw.encode(), hashed.encode())
    except (ValueError, TypeError):
        return False


async def check(raw: str | None, hashed: str | None) -> bool:
    """Does ``raw`` match the bcrypt ``hashed``? Off the event loop, and cached when it does."""
    if not raw or not hashed:
        return False
    k = _key(raw, hashed)
    now = time.monotonic()
    exp = _OK.get(k)
    if exp is not None:
        if exp > now:
            return True
        _OK.pop(k, None)
    ok = await asyncio.to_thread(check_sync, raw, hashed)
    if ok:
        if len(_OK) >= _OK_MAX:
            for old in [x for x, e in _OK.items() if e <= now] or list(_OK)[: _OK_MAX // 4]:
                _OK.pop(old, None)
        _OK[k] = now + _OK_TTL
    return ok


def forget() -> None:
    """Drop every remembered check (tests; a rotated secret needs nothing: its hash changed)."""
    _OK.clear()


def hash_sync(raw: str, rounds: int | None = None) -> str:
    salt = bcrypt.gensalt(rounds) if rounds else bcrypt.gensalt()
    return bcrypt.hashpw(raw.encode(), salt).decode()


async def hash_secret(raw: str, rounds: int | None = None) -> str:
    """bcrypt.hashpw on a worker thread."""
    return await asyncio.to_thread(hash_sync, raw, rounds)


def generate_edit_secret() -> tuple[str, str]:
    """Returns (raw_secret, bcrypt_hash). Blocking: use ``new_edit_secret`` from async code."""
    raw = "sk_" + secrets.token_hex(20)
    return raw, hash_sync(raw)


async def new_edit_secret() -> tuple[str, str]:
    """(raw_secret, bcrypt_hash), hashed off the event loop."""
    raw = "sk_" + secrets.token_hex(20)
    return raw, await hash_secret(raw)


def verify_edit_secret(raw: str, hashed: str) -> bool:
    return bcrypt.checkpw(raw.encode(), hashed.encode())
