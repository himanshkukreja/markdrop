import secrets

import bcrypt


def generate_edit_secret() -> tuple[str, str]:
    """Returns (raw_secret, bcrypt_hash)."""
    raw = "sk_" + secrets.token_hex(20)
    hashed = bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()
    return raw, hashed


def verify_edit_secret(raw: str, hashed: str) -> bool:
    return bcrypt.checkpw(raw.encode(), hashed.encode())
