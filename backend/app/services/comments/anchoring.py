"""Anchors: where a thread points (CONTRACT §2). Text quote (W3C TextQuoteSelector), whole block, or page.

Content stays clean: nothing is written into the Markdown. A thread stores its anchor; the server re-anchors
it on every save against the new text and marks it ``attached`` or ``changed``.
"""

from __future__ import annotations

from dataclasses import dataclass


class AnchorError(ValueError):
    code = "anchor_not_found"


@dataclass
class Block:
    index: int
    bid: str | None
    kind: str
    text: str
    start: int
    end: int


def normalise(text: str | None) -> str:
    raise NotImplementedError


def blocks(markdown: str | None) -> list[Block]:
    raise NotImplementedError


def plain_text(markdown: str | None) -> str:
    raise NotImplementedError


def fingerprint(text: str) -> str:
    raise NotImplementedError


def make_anchor(markdown: str, anchor_in: dict, rev: int) -> dict:
    raise NotImplementedError


def anchor_from_quote(markdown: str, quote: str, rev: int, *, block_id: str | None = None, occurrence: int = 1) -> dict:
    raise NotImplementedError


def resolve(markdown: str, anchor: dict, rev: int) -> tuple[dict, str]:
    raise NotImplementedError


async def reanchor_item(db, doc: dict, *, force: bool = False) -> int:
    raise NotImplementedError


async def on_content_saved(db, before: dict | None, after: dict) -> None:
    raise NotImplementedError
