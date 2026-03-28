import secrets

# Base58 alphabet — no 0, O, I, l to avoid confusion
ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def generate_slug(length: int = 7) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))
