"""Threads and messages (CONTRACT §4). Every function decides access itself (perms.require)."""

from __future__ import annotations

from app.services.comments.model import MAX_BODY, MAX_MENTIONS, MAX_THREADS_PER_ITEM  # noqa: F401


async def list_threads(db, actor, raw, ctx, *, status: str = "all", mine: bool = False) -> dict:
    raise NotImplementedError


async def get_thread(db, actor, raw, ctx, thread_id: str) -> dict:
    raise NotImplementedError


async def create_thread(db, actor, raw, ctx, *, anchor: dict, body: str, mentions: list[str] | None = None,
                        assignee: str | None = None, via: str | None = None,
                        attachments: list[str] | None = None, suggestion: str | None = None) -> dict:
    raise NotImplementedError


async def reply(db, actor, raw, ctx, thread_id: str, *, body: str, mentions: list[str] | None = None,
                via: str | None = None, attachments: list[str] | None = None, ai: bool = False,
                kind: str = "comment", suggestion: str | None = None) -> tuple[dict, dict]:
    raise NotImplementedError


async def edit_message(db, actor, raw, ctx, thread_id: str, message_id: str, *, body: str,
                       mentions: list[str] | None = None) -> dict:
    raise NotImplementedError


async def delete_message(db, actor, raw, ctx, thread_id: str, message_id: str) -> None:
    raise NotImplementedError


async def resolve(db, actor, raw, ctx, thread_id: str, *, via: str | None = None) -> dict:
    raise NotImplementedError


async def reopen(db, actor, raw, ctx, thread_id: str, *, via: str | None = None) -> dict:
    raise NotImplementedError


async def react(db, actor, raw, ctx, thread_id: str, message_id: str, emoji: str, *, on: bool | None = None) -> dict:
    raise NotImplementedError


async def assign(db, actor, raw, ctx, thread_id: str, assignee: str | None) -> dict:
    raise NotImplementedError


async def update_settings(db, actor, raw, ctx, *, enabled: bool | None = None, public: bool | None = None) -> dict:
    raise NotImplementedError


async def recount(db, doc_id: str) -> dict:
    raise NotImplementedError


async def open_threads(db, doc_id: str) -> list[dict]:
    raise NotImplementedError


async def load_thread(db, doc_id: str, thread_id: str) -> dict | None:
    raise NotImplementedError


async def thread_out(db, actor, raw, ctx, thread: dict, perms=None) -> dict:
    raise NotImplementedError


async def touch(db, raw: dict, thread: dict, *, op: str, actor=None, message: dict | None = None) -> None:
    raise NotImplementedError


def live_event(doc: dict, thread: dict, op: str) -> None:
    """``{"type": "comments", "rev", "thread", "op", "pub"}`` on the item's socket (CONTRACT §8)."""
    raise NotImplementedError


async def on_item_deleted(db, doc_id: str) -> None:
    raise NotImplementedError


async def anonymise_user(db, user_id: str) -> int:
    raise NotImplementedError


async def summary_for_read(db, actor, raw, ctx) -> dict | None:
    """``DocumentResponse.comments``: None | {"enabled","public","open","can_view","can_comment","reason"}."""
    raise NotImplementedError
