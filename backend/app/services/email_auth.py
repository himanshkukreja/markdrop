"""Passwordless email login — magic link + OTP challenges.

A single `login_challenges` document per email holds a bcrypt-hashed 6-digit
OTP and a SHA-256-hashed magic-link token. Either path consumes the whole
challenge. Records auto-expire via a TTL index on `expires_at`.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()


def _generate_otp() -> str:
    return f"{secrets.randbelow(10 ** settings.otp_length):0{settings.otp_length}d}"


def _hash_link_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_challenge(db: AsyncIOMotorDatabase, email: str) -> tuple[str, str]:
    """Create a fresh login challenge for `email`. Returns (otp, link_token).

    Any prior unconsumed challenge for the same email is replaced.
    """
    email = email.lower()
    otp = _generate_otp()
    link_token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)

    await db["login_challenges"].delete_many({"email": email})
    await db["login_challenges"].insert_one(
        {
            "email": email,
            "otp_hash": bcrypt.hashpw(otp.encode(), bcrypt.gensalt()).decode(),
            "link_token_hash": _hash_link_token(link_token),
            "expires_at": now + timedelta(minutes=settings.login_challenge_ttl_minutes),
            "attempts": 0,
            "created_at": now,
        }
    )
    return otp, link_token


def _is_expired(challenge: dict) -> bool:
    exp = challenge["expires_at"]
    if exp.tzinfo is None:  # Mongo returns naive UTC
        exp = exp.replace(tzinfo=timezone.utc)
    return exp < datetime.now(timezone.utc)


async def verify_otp(db: AsyncIOMotorDatabase, email: str, code: str) -> str | None:
    """Return the verified email on success, else None. Consumes on success."""
    email = email.lower()
    challenge = await db["login_challenges"].find_one({"email": email})
    if not challenge or _is_expired(challenge):
        return None
    if challenge.get("attempts", 0) >= settings.login_max_attempts:
        return None

    if not bcrypt.checkpw(code.encode(), challenge["otp_hash"].encode()):
        await db["login_challenges"].update_one(
            {"_id": challenge["_id"]}, {"$inc": {"attempts": 1}}
        )
        return None

    await db["login_challenges"].delete_one({"_id": challenge["_id"]})
    return email


async def verify_link(db: AsyncIOMotorDatabase, token: str) -> str | None:
    """Return the verified email for a valid magic-link token, else None."""
    challenge = await db["login_challenges"].find_one(
        {"link_token_hash": _hash_link_token(token)}
    )
    if not challenge or _is_expired(challenge):
        return None
    await db["login_challenges"].delete_one({"_id": challenge["_id"]})
    return challenge["email"]
