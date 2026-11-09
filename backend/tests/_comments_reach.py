"""Shared world for Track C's comment tests (email, Slack, digest, analytics, exports).

Threads, messages and bell rows are written straight into Mongo in the CONTRACT's shapes (§1, §10), so these
tests don't depend on Track A's service; the access-policy world (tests/_access_env.py) as always, never
backend/.env. Email is never sent (``mailer._post`` records each payload: tests/test_notifications.NotifyWorld).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tests._access_env import now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.services import notifications
from app.services.comments import model
from tests.test_notifications import NotifyWorld

T, M = model.THREADS, model.MESSAGES

PAGE = ("# Launch plan\n\nShip the frontend by Friday. {#b-ship01}\n\n## Risks\n\n"
        "The payments API is still flaky under load. {#b-risk01}\n\n## Budget\n\nWe have room for one more hire.\n")


class ReachWorld(NotifyWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await model.ensure_indexes(self.db)

    async def item(self, state: str = "W", content: str = PAGE, **kw) -> dict:
        return await self.mkdoc(state, editor="blocks", content=content, **kw)

    async def thread(self, doc: dict, by: str = "owner", *, quote: str | None = "frontend",
                     block_id: str | None = "b-ship01", block_text: str | None = None, body: str = "Is Friday real?",
                     mentions: tuple[str, ...] = (), assignee: str | None = None, status: str = "open",
                     at: datetime | None = None, anchor_status: str = "attached", kind: str | None = None) -> dict:
        at = at or now()
        uid = self.uid[by]
        men = [self.uid[m] for m in mentions]
        typ = kind or ("text" if quote else "block" if block_text else "page")
        anchor = {"type": typ, "block_id": block_id if typ != "page" else None, "block_index": None, "block_fp": None,
                  "block_text": block_text, "quote": {"exact": quote, "prefix": "", "suffix": ""} if quote else None,
                  "start": None, "rev": 1}
        row = {"doc_id": str(doc["_id"]), "workspace_id": doc.get("workspace_id"), "item_kind": "page",
               "anchor": anchor, "original": {"exact": quote, "block_text": block_text}, "anchor_status": anchor_status,
               "status": status, "created_by": uid, "created_at": at, "updated_at": at,
               "resolved_by": uid if status == "resolved" else None, "resolved_at": at if status == "resolved" else None,
               "assignee": self.uid[assignee] if assignee else None, "assigned_by": uid if assignee else None,
               "assigned_at": at if assignee else None,
               "participants": sorted({uid, *men, *([self.uid[assignee]] if assignee else [])}),
               "mentions": men, "message_count": 1, "last_message_at": at, "last_author_id": uid,
               "history": [], "suggestion": None, "deleted_at": None}
        res = await self.db[T].insert_one(row)
        row["_id"] = res.inserted_id
        # documents.comment_counts, as service.recount keeps it (CONTRACT §1.3).
        await self.db["documents"].update_one({"_id": doc["_id"]}, {"$inc": {f"comment_counts.{status}": 1}})
        await self.message(row, by, body, at=at, mentions=mentions)
        return row

    async def message(self, thread: dict, by: str, body: str, *, at: datetime | None = None,
                      mentions: tuple[str, ...] = ()) -> dict:
        at = at or now()
        m = {"thread_id": thread["_id"], "doc_id": thread["doc_id"], "author_id": self.uid[by], "author_name": by.upper(),
             "body": body, "mentions": [self.uid[x] for x in mentions], "attachments": [], "reactions": {},
             "created_at": at, "edited_at": None, "deleted_at": None, "via": None, "ai": False, "kind": "comment"}
        res = await self.db[M].insert_one(m)
        m["_id"] = res.inserted_id
        if at > thread["created_at"]:
            await self.db[T].update_one({"_id": thread["_id"]}, {
                "$inc": {"message_count": 1}, "$set": {"last_message_at": at, "last_author_id": self.uid[by], "updated_at": at},
                "$addToSet": {"participants": {"$each": [self.uid[by], *(self.uid[x] for x in mentions)]},
                              "mentions": {"$each": [self.uid[x] for x in mentions]}}})
        return m

    async def bell(self, who: str, kind: str, doc: dict, thread: dict, by: str = "owner", *,
                   excerpt: str = "Is Friday real?", at: datetime | None = None, count: int | None = None) -> dict:
        """A bell row as Track A's notify_app makes it (CONTRACT §10), email state from the person's settings."""
        at = at or now()
        recipient = await self.db["users"].find_one({"_id": ObjectId(self.uid[who])})
        extra = {"excerpt": excerpt, **({"count": count} if count else {})}
        row = {"user_id": self.uid[who], "kind": kind, "doc_id": str(doc["_id"]), "block_id": None,
               "thread_id": str(thread["_id"]), "actor_id": self.uid[by], "actor_name": by.upper(), "via": None,
               "extra": extra, "created_at": at, "read_at": None,
               "email": "pending" if notifications.wants_email(recipient, kind) else "off",
               "email_at": at + notifications.GATHER, "emailed_at": None}
        res = await self.db[notifications.COLL].insert_one(row)
        row["_id"] = res.inserted_id
        return row

    async def flush_at(self, when: datetime) -> dict:
        return await notifications.flush_emails(self.db, when)

    async def set_email(self, who: str, **modes) -> None:
        r = await self.http.patch("/api/v1/me/preferences", json={"email_notify": modes}, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)


def utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


__all__ = ["ReachWorld", "PAGE", "T", "M", "now", "timedelta", "utc"]
