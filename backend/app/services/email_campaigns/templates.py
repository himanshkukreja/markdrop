"""Starting points for a campaign.

* ``newsletter``: a block document in the light shell (edit freely).
* ``artifacts``, ``encryption-workspaces``, ``blank-html``: the full-HTML
  announcements the old admin emailer offered, now stored as files in
  ``app/emails/campaigns/`` (``{{name}}`` became ``{{first_name|there}}``).
* ``welcome``: generated from the live welcome email in ``mailer.py`` on every
  call, so a campaign sends exactly the approved design: rendered once with a
  sentinel name and once without, the name-dependent lines become
  ``{{#if first_name}}…{{else}}…{{/if}}`` and the sentinel ``{{first_name}}``.
  The transactional footer's "only welcome email" line is swapped for an
  Unsubscribe link.

Raw templates carry their own preheader inside the HTML; their plain-text part
is derived from the HTML once, here, and is then editable.
"""

from __future__ import annotations

import difflib
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.services import mailer

from .render import DEFAULT_FOOTER, html_to_text, new_block_id

_DIR = Path(__file__).resolve().parent.parent.parent / "emails" / "campaigns"
_S_NAME = "Zqxmergefirst"


def _merge_variants(a: str, b: str) -> str:
    """Line diff of a (named) vs b (anonymous): differing hunks become a conditional."""
    la, lb = a.split("\n"), b.split("\n")
    out: list[str] = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=la, b=lb, autojunk=False).get_opcodes():
        if op == "equal":
            out.extend(la[i1:i2])
        else:
            out.append(f"{{{{#if first_name}}}}{chr(10).join(la[i1:i2])}{{{{else}}}}{chr(10).join(lb[j1:j2])}{{{{/if}}}}")
    return "\n".join(out)


_UNSUB_LINK = '<a href="{{unsubscribe_url}}" style="color:#6a7282;text-decoration:underline">Unsubscribe</a>'


def _campaign_footer(html: str) -> str:
    html = html.replace("It's the only welcome email we send. ", "")
    marker = "star it on GitHub</a>."
    if marker in html:
        return html.replace(marker, f"{marker} {_UNSUB_LINK}", 1)
    # The footer changed shape: still never ship without an opt-out.
    idx = html.lower().rfind("</body>")
    foot = f'<div style="text-align:center;padding:0 0 24px;font-size:12px">{_UNSUB_LINK}</div>'
    return html[:idx] + foot + html[idx:] if idx != -1 else html + foot


def _welcome_doc() -> dict[str, Any]:
    named = _campaign_footer(mailer._welcome_html(_S_NAME))
    anon = _campaign_footer(mailer._welcome_html(None))
    html = _merge_variants(named, anon).replace(_S_NAME, "{{first_name}}")
    # The text part is merged from each variant's own text, so a conditional
    # never lands inside a tag the HTML-to-text pass has to read.
    text = _merge_variants(html_to_text(named), html_to_text(anon)).replace(_S_NAME, "{{first_name}}")
    return {"layout": "raw", "html": html, "text": text, "source": "app/services/mailer.py · _welcome_html"}


@lru_cache(maxsize=8)
def _file_doc(name: str) -> dict[str, Any]:
    html = (_DIR / f"{name}.html").read_text(encoding="utf-8")
    return {"layout": "raw", "html": html, "text": html_to_text(html), "source": f"app/emails/campaigns/{name}.html"}


def _newsletter_doc() -> dict[str, Any]:
    return {
        "layout": "blocks",
        "top_label": "Product update",
        "footer": DEFAULT_FOOTER,
        "blocks": [
            {"id": new_block_id(), "type": "hero", "eyebrow": "What's new", "title": "A headline that earns the open"},
            {"id": new_block_id(), "type": "text", "md": (
                "Hi {{first_name|there}},\n\n"
                "Write the update here. **Bold**, *italic*, [links](https://markdrop.in) and lists work.\n\n"
                "- {{#if doc_count}}You've published **{{doc_count}}** documents so far{{else}}Your first document is one paste away{{/if}}\n"
                "- Everything renders in any browser, no app needed"
            )},
            {"id": new_block_id(), "type": "button", "label": "Open your dashboard", "url": "{{dashboard_url}}"},
            {"id": new_block_id(), "type": "text", "md": "Reply to this email if anything looks off. I read every reply.\n\nHimanshu, Markdrop"},
        ],
    }


def all_templates() -> list[dict[str, Any]]:
    """Template catalogue (fresh docs each call: callers may mutate them)."""
    return [
        {
            "id": "newsletter",
            "name": "Product update",
            "kind": "blocks",
            "description": "Editable blocks (markdown text, buttons, features, a callout, images, raw HTML) in the Markdrop email shell.",
            "subject": "{{first_name}}, what's new in Markdrop",
            "subject_fallback": "What's new in Markdrop",
            "preheader": "The short version, in two minutes.",
            "doc": _newsletter_doc(),
            "audience": {"kind": "all"},
        },
        {
            "id": "artifacts",
            "name": "Artifacts announcement",
            "kind": "raw",
            "description": "Files that render: HTML pages, PDFs, spreadsheets, Word docs and video.",
            "subject": "New in Markdrop: PDFs, spreadsheets and web pages that render",
            "subject_fallback": None,
            "preheader": None,
            "doc": dict(_file_doc("artifacts")),
            "audience": {"kind": "all"},
        },
        {
            "id": "encryption-workspaces",
            "name": "Encryption and workspaces",
            "kind": "raw",
            "description": "End-to-end encrypted documents, and workspaces on your own domain.",
            "subject": "Encrypted documents, and your own domain",
            "subject_fallback": None,
            "preheader": None,
            "doc": dict(_file_doc("encryption-workspaces")),
            "audience": {"kind": "all"},
        },
        {
            "id": "welcome",
            "name": "Welcome email",
            "kind": "raw",
            "description": "The new-account feature tour, for people who signed up before it existed. Generated from mailer.py.",
            "subject": "Welcome to Markdrop: everything you can do",
            "subject_fallback": None,
            "preheader": None,
            "doc": _welcome_doc(),
            "audience": {"kind": "all"},
        },
        {
            "id": "blank-html",
            "name": "Blank HTML",
            "kind": "raw",
            "description": "The light shell with a heading, a paragraph and a button, as HTML to edit by hand.",
            "subject": "",
            "subject_fallback": None,
            "preheader": None,
            "doc": dict(_file_doc("blank")),
            "audience": {"kind": "all"},
        },
    ]


def get_template(tid: str) -> dict[str, Any] | None:
    return next((t for t in all_templates() if t["id"] == tid), None)


def preheader_of(html: str) -> str | None:
    m = re.search(r'<div style="display:none[^>]*>([^<&]*)', html or "")
    return m.group(1).strip() if m and m.group(1).strip() else None
