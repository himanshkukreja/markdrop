"""The Slack messages the docs illustrate, built by Markdrop's own Block Kit builders
(backend/app/services/slack_blocks.py) from the demo world's content: nothing here is drawn by hand.

    backend/.venv/bin/python frontend/scripts/docs-media/slack/payloads.py   → slack/payloads.json

The docs show them as neutral illustrations (shots/i-slack.mjs renders them on a plain card, labelled
"Illustration"), never as screenshots of Slack itself. Rerun after changing slack_blocks.py.
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO / "backend"))
# Builders only: no database, no network. A throwaway signing secret for the buttons' values.
os.environ.setdefault("MARKDROP_SLACK_SIGNING_SECRET", "docs-illustration-only")
os.environ.setdefault("MARKDROP_AUTH_SECRET", "docs-illustration-only")

from app.services import slack_blocks as kit  # noqa: E402

TEAM = "T0ACME"
BASE = "https://markdrop.in"
ACME = "https://docs.acme.com"


def esc(s: str) -> str:
    return kit.esc(s)


meeting = kit.meeting_post(
    TEAM, "6aecc9488c77e564c2be27a1",
    title="Weekly product sync", url=f"{BASE}/weekly-product-sync-nov-4", when="Tue Nov 4, 2026 · 10:00",
    summary=("We agreed to ship the new onboarding checklist on Nov 12 and to keep the old flow behind a flag for "
             "two weeks. Billing's annual-plan bug is fixed in 2.4.1; support will tell the three affected customers."),
    decisions=["Ship the onboarding checklist on Nov 12", "Keep the old onboarding flow behind a flag for two weeks"],
    items=[
        {"block": "b-1a2b3c4d", "text": f"<@U0MAYA> {esc('Update the onboarding docs before the release')}", "done_by": None},
        {"block": "b-2b3c4d5e", "text": f"<@U0ALEX> {esc('Email the three affected billing customers')}", "done_by": None},
        {"block": "b-3c4d5e6f", "text": f"<@U0SAM> {esc('Turn on the flag in staging')}", "done_by": "Sam Lee"},
    ])

search = kit.search_results("onboarding", [
    {"title": "Onboarding guide", "kind": "page", "web_url": f"{ACME}/guides/onboarding-guide",
     "workspace": {"name": "Acme"}, "snippet": {"text": "Everything a new teammate needs in their first week: accounts, tools and who to ask."}},
    {"title": "Onboarding handbook", "kind": "file", "type_label": "PDF", "web_url": f"{ACME}/onboarding-handbook",
     "workspace": {"name": "Acme"}, "snippet": {"text": "Benefits, time off and the team calendar."}},
    {"title": "Getting started", "kind": "doc", "web_url": f"{ACME}/guides/setup/getting-started",
     "workspace": {"name": "Acme"}, "snippet": {"text": "Install the CLI, connect a data source and invite your team."}},
], more_url=f"{BASE}/search?q=onboarding")

answer = kit.answer(
    "How do I connect Postgres?",
    ("Create a read-only user in Postgres, then add it under Settings › Data sources › Postgres with the host, port "
     "and database [1]. Connections from Acme come from two fixed IP addresses you can allow in your firewall [2]."),
    [{"n": 1, "title": "Connect Postgres", "url": f"{ACME}/guides/setup/connect-postgres"},
     {"n": 2, "title": "Security FAQ", "url": f"{ACME}/security-faq"}])

meetings_answer = kit.answer(
    "When do we ship the onboarding checklist?",
    "On Nov 12. It was decided in the Weekly product sync on Nov 4, with the old flow kept behind a flag for two weeks [1].",
    [{"n": 1, "title": "Weekly product sync, Nov 4 (Maya Patel at 12:40)", "url": f"{BASE}/weekly-product-sync-nov-4#t=760"}])

# Previews are for markdrop.in links (a workspace's own domain isn't in the app's unfurl domains).
unfurl = kit.item_unfurl(
    f"{BASE}/connect-postgres", "Connect Postgres", kind="Page",
    excerpt="Create a read-only user, add it under Settings › Data sources, and check the connection. Takes about five minutes.",
    where="Acme", updated="Nov 3, 2026")
unfurl_minimal = kit.minimal_unfurl(f"{BASE}/q3-plan-internal")

mention = kit.dm_mention("Alex Chen", "Release notes 2.4", f"{BASE}/release-notes-2-4#b-9f8e7d6c",
                         "@Riya Sharma can you check the migration steps before we publish?")
access_request = kit.dm_access_request(
    TEAM, "Jordan Park", "jordan@northwind.com", "Q3 plan", f"{BASE}/requests/6aecc9488c77e564c2be2796",
    "6aecc9488c77e564c2be2796", True, "I'm preparing the partner review and need to add our numbers.", False)
access_done = kit.dm_access_request(
    TEAM, "Jordan Park", "jordan@northwind.com", "Q3 plan", f"{BASE}/requests/6aecc9488c77e564c2be2796",
    "6aecc9488c77e564c2be2796", True, "I'm preparing the partner review and need to add our numbers.", False,
    done="Approved by you: they can edit it now.")
help_msg = kit.help_message("Riya Sharma")

# Each person's own action items after a meeting (services/slack_action_items.py): a member who can
# edit the page (Open the notes, Done), and someone outside Markdrop (their items and who to ask).
ai_member = kit.dm_action_items(TEAM, "6aecc9488c77e564c2be27b0", [{
    "title": "Weekly product sync", "when": "Nov 4", "url": f"{BASE}/weekly-product-sync-nov-4", "organizer": None,
    "can_edit": True, "items": [
        {"block": "b-1a2b3c4d", "text": esc("Update the onboarding docs before the release"),
         "due": "next Wednesday (Wed, Nov 11)", "done": False},
        {"block": "b-4d5e6f70", "text": esc("Send Alex the new screenshots"), "due": "Thu, Nov 5", "done": False},
    ]}], stop_value=kit.slack.sign_value(TEAM, "stop", "U0MAYA", "6aecc9488c77e564c2be27b1"))
ai_outside = kit.dm_action_items(TEAM, "6aecc9488c77e564c2be27b2", [{
    "title": "Weekly product sync", "when": "Nov 4", "url": None, "organizer": "Riya Sharma", "can_edit": False,
    "items": [{"block": "b-5e6f7081", "text": esc("Share the partner pricing sheet with finance"), "due": "Fri, Nov 6",
               "done": False}]}], stop_value=kit.slack.sign_value(TEAM, "stop", "U0JORDAN", ""))

out = {
    # Slack user ids in the messages → the names a reader would see.
    "users": {"U0MAYA": "Maya Patel", "U0ALEX": "Alex Chen", "U0SAM": "Sam Lee"},
    "meeting_post": {"where": "#meetings", "from": "Markdrop", "message": meeting},
    "search": {"where": "/markdrop search onboarding", "from": "Markdrop", "ephemeral": True, "message": search},
    "ask": {"where": "/markdrop ask How do I connect Postgres?", "from": "Markdrop", "ephemeral": True, "message": answer},
    "meetings_ask": {"where": "/markdrop meetings When do we ship the onboarding checklist?", "from": "Markdrop",
                     "ephemeral": True, "message": meetings_answer},
    "unfurl": {"where": "#product", "from": "Alex Chen", "text": f"{BASE}/connect-postgres  {BASE}/q3-plan-internal",
               "unfurls": [unfurl, unfurl_minimal]},
    "dm_mention": {"where": "Direct message", "from": "Markdrop", "message": mention},
    "dm_access_request": {"where": "Direct message", "from": "Markdrop", "message": access_request, "after": access_done},
    "help": {"where": "/markdrop help", "from": "Markdrop", "ephemeral": True, "message": help_msg},
    "dm_action_items": {"where": "Direct message", "from": "Markdrop", "message": ai_member, "after": ai_outside,
                        "afterLabel": "Someone who isn't in Markdrop gets only their own items:"},
}
# Button values are signed with the throwaway secret above; they mean nothing outside this file.
(HERE / "payloads.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(f"wrote {HERE / 'payloads.json'}")
