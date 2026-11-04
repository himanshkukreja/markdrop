"""MCP tools for sign-off blocks (services/signoffs.py): ``list_signoffs`` and
``sign_off``.

A sign-off block names one person; only that person can choose an option (an
MCP call counts as its user). The decision lives on the server, never in the
Markdown, so writing ``option=…`` into a block does nothing; once signed, page
writes that change the block (or, with ``lock=above``, the section above it)
are refused until the signer clears their decision.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    _URL_PROPS,
    ENCRYPTED_READ,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    load_for,
    url_pair,
)
from app.services import access as access_service
from app.services import signoffs

_NOT_A_PAGE = "That's a file, not a page, so it has no sign-off blocks."


def _actx(ctx: Context) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp")


def _item(e: dict) -> dict[str, Any]:
    person = e.get("person") or {}
    by = e.get("signed_by") or {}
    return {
        "block": e["block"], "label": e["label"], "person": person.get("id"), "person_name": person.get("name"),
        "options": e["options"], "option": e.get("option"), "signed_by": by.get("name") if by else None,
        "signed_by_id": by.get("id") if by else None, "signed_at": e.get("signed_at"), "lock": e.get("lock"),
        "you_sign": bool(e.get("can_sign")), "history": e.get("history") or [],
    }


def _line(i: dict) -> str:
    who = i["person_name"] or ("you" if i["you_sign"] else "a person")
    state = (f"signed: {i['option']} ({i['signed_by'] or who}, {i['signed_at']})" if i["option"]
             else f"waiting for {who}")
    lock = "; locks the section above once signed" if i["lock"] == "above" else ""
    return f"- {i['label']} [{i['block']}] — {state}. Options: {' | '.join(i['options'])}{lock}"


async def list_signoffs(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "read", "read")
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_READ)
    if raw.get("kind") == "artifact":
        raise ToolError(_NOT_A_PAGE)
    items = [_item(e) for e in await signoffs.listing(ctx.db, raw, actor_of(ctx), _actx(ctx))]
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "signoffs": items}
    if not items:
        return f"{out['url']} has no sign-off blocks.", out
    head = f"Sign-offs on {out['url']}:"
    return "\n".join([head, *(_line(i) for i in items)]), out


async def sign_off(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "read", "sign off on")
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_READ)
    if raw.get("kind") == "artifact":
        raise ToolError(_NOT_A_PAGE)
    option = args.get("option")
    try:
        e = await signoffs.sign(ctx.db, raw, args["block"], option, actor_of(ctx), _actx(ctx), via="mcp")
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    item = _item(e)
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], **item}
    if item["option"]:
        lock = " The section above it is now locked." if item["lock"] == "above" else ""
        text = f"Signed off “{item['label']}” on {out['url']}: {item['option']}.{lock}"
    else:
        text = f"Cleared your sign-off “{item['label']}” on {out['url']}: the block can be edited again."
    return text, out


_ITEM = {
    "block": {"type": "string"}, "label": {"type": "string"}, "person": {"type": ["string", "null"]},
    "person_name": {"type": ["string", "null"]}, "options": {"type": "array", "items": {"type": "string"}},
    "option": {"type": ["string", "null"]}, "signed_by": {"type": ["string", "null"]},
    "signed_by_id": {"type": ["string", "null"]}, "signed_at": {"type": ["string", "null"]},
    "lock": {"type": ["string", "null"]}, "you_sign": {"type": "boolean"}, "history": {"type": "array"},
}
_ITEM_REQUIRED = ["block", "label", "person", "options", "option", "signed_by", "signed_at"]

SIGNOFF_TOOLS: list[Tool] = [
    Tool(
        name="list_signoffs",
        title="List a page's sign-offs",
        description=(
            "The sign-off blocks on a page (':::signoff{#b-… person=\"<user id>\" label=\"…\" options=\"A|B\" "
            "lock=above}'): for each, its block id, label, the person who signs it (id, and name when the user "
            "may see names), the options, the decision (option, signed_by, signed_at; null while waiting), "
            "lock ('above' when signing locks the section above it), whether the user is the one who signs "
            "(you_sign) and its recent history. The decision comes from Markdrop, never from the Markdown."),
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"},
                            "signoffs": {"type": "array", "items": {"type": "object", "properties": _ITEM,
                                                                    "required": _ITEM_REQUIRED}}},
                           ["url", "markdrop_url", "slug", "signoffs"]),
        annotations=_ann(True, False, True),
        handler=list_signoffs,
    ),
    Tool(
        name="sign_off",
        title="Sign off a page's sign-off block",
        description=(
            "Choose an option in a sign-off block. Only the person the block names can (the user this app "
            "acts for); anyone else is refused. block is its id (b-…, as list_signoffs gives it) or its label "
            "when only one block has it; option must be one of its options (null, or no option, clears the "
            "user's decision, which unlocks the block). The choice, the user's name and the time are recorded, and the page's "
            "version history says so. Once signed, edits that change the block (or, with lock=above, the "
            "section above it) are refused for everyone until the signer clears it; a workspace admin can "
            "remove a signed block, which is recorded."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "block": {"type": "string", "minLength": 1, "maxLength": 200,
                      "description": "The block's id (b-…) or its label."},
            "option": {"type": ["string", "null"], "maxLength": 100,
                       "description": "One of the block's options. null (or leaving it out) clears the "
                                      "user's decision."},
        }, "required": ["document", "block"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, **_ITEM},
                           ["url", "markdrop_url", "slug", *_ITEM_REQUIRED]),
        annotations=_ann(False, False, True),
        handler=sign_off,
    ),
]
