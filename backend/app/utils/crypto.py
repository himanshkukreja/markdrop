"""Symmetric encryption for secrets that must be recovered later (unlike
password/edit-secret hashes, which are one-way).

Currently used to protect Google OAuth **refresh tokens** at rest: a refresh
token grants long-lived access to the user's Drive, so it must never sit in the
database in plaintext. Uses Fernet (AES-128-CBC + HMAC) keyed by
``settings.token_encryption_key``.
"""

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class EncryptionUnavailable(RuntimeError):
    """Raised when encryption is requested but no key is configured."""


@lru_cache
def _fernet() -> Fernet:
    key = get_settings().token_encryption_key
    if not key:
        raise EncryptionUnavailable(
            "MARKDROP_TOKEN_ENCRYPTION_KEY is not set — required to store Google tokens."
        )
    return Fernet(key.encode())


def is_configured() -> bool:
    return bool(get_settings().token_encryption_key)


def encrypt(plaintext: str) -> str:
    """Encrypt a UTF-8 string, returning a URL-safe token string."""
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    """Decrypt a token produced by :func:`encrypt`.

    Raises ``InvalidToken`` if the ciphertext is corrupt or the key changed.
    """
    return _fernet().decrypt(token.encode()).decode()


__all__ = ["encrypt", "decrypt", "is_configured", "EncryptionUnavailable", "InvalidToken"]
