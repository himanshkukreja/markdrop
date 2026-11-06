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
    title="Weekly product sync", url=f"{BASE}/weekly-product-sync-nov-4", when="Tue, Nov 4 · 10:00", day="Nov 4",
    duration="32 min", people=["Maya Patel", "Alex Chen", "Sam Lee"], people_total=5,
    summary=("We agreed to ship the new onboarding checklist on Nov 12 and to keep the old flow behind a flag for "
             "two weeks. Billing's annual-plan bug is fixed in 2.4.1; support will tell the three affected customers. "
             "Sam is finishing the partner pricing sheet, and finance wants it before Thursday's review."),
    decisions=["Ship the onboarding checklist on Nov 12", "Keep the old onboarding flow behind a flag for two weeks"],
    open_questions=["Do the EU tiers need legal review before the partner review?"],
    items=[
        {"block": "b-1a2b3c4d", "owner": "<@U0MAYA>", "owner_key": "u:maya",
         "text": esc("Update the onboarding docs before the release"), "due": "Tue, Nov 11", "done_by": None},
        {"block": "b-2b3c4d5e", "owner": "<@U0ALEX>", "owner_key": "u:alex",
         "text": esc("Email the three affected billing customers"), "due": "Thu, Nov 6", "done_by": None},
        {"block": "b-3c4d5e6f", "owner": "<@U0SAM>", "owner_key": "u:sam", "text": esc("Turn on the flag in staging"),
         "due": None, "done_by": "Sam Lee"},
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
                         "@Riya Sharma can you check the migration steps before we publish?", where="Acme")
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

# Team's weekly summary in the meetings channel (services/team_extras.py slack_blocks): Monday 9 am.
from app.services import team_extras  # noqa: E402
from app.services import workspace_memory as _wm  # noqa: E402

_src = lambda title, slug: [{"title": title, "href": f"{BASE}/{slug}"}]  # noqa: E731
weekly_blocks, _weekly_text = team_extras.slack_blocks(_wm.WsInfo("6aecc9488c77e564c2be27c0", "Acme", True, True), {
    "from": "2026-11-03", "to": "2026-11-09",
    "meetings": [{"title": "Weekly product sync", "date": "2026-11-04", "time": "10:00", "href": "/weekly-product-sync-nov-4"},
                 {"title": "Pricing review", "date": "2026-11-05", "time": "15:30", "href": "/pricing-review-nov-5"}],
    "highlights": [
        {"person": {"name": "Maya Patel"}, "text": "Shipped the onboarding checklist behind a flag",
         "sources": _src("Weekly product sync", "weekly-product-sync-nov-4")},
        {"person": {"name": "Alex Chen"}, "text": "Fixed the annual-plan billing bug in 2.4.1",
         "sources": _src("Daily standup", "daily-standup-nov-5")},
        {"person": {"name": "Sam Lee"}, "text": "Decided: the partner pricing sheet goes to finance first",
         "sources": _src("Pricing review", "pricing-review-nov-5")}],
    "blockers": [{"person": {"name": "Jordan Park"}, "text": "The Postgres connector needs read-only credentials",
                  "waiting_on": "Alex Chen"}],
    "due": [{"person": {"name": "Maya Patel"}, "text": "Update the onboarding docs", "due": "2026-11-11"},
            {"person": {"name": "Sam Lee"}, "text": "Send the release notes to customers", "due": "2026-11-12"}],
    "overdue": [{"person": {"name": "Alex Chen"}, "text": "Triage the crash reports", "due": "2026-11-06", "days": -3}],
})
weekly = {"blocks": weekly_blocks, "text": _weekly_text}

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
    "team_weekly": {"where": "#meetings", "from": "Markdrop", "message": weekly},
    "help": {"where": "/markdrop help", "from": "Markdrop", "ephemeral": True, "message": help_msg},
    "dm_action_items": {"where": "Direct message", "from": "Markdrop", "message": ai_member, "after": ai_outside,
                        "afterLabel": "Someone who isn't in Markdrop gets only their own items:"},
}
# Button values are signed with the throwaway secret above; they mean nothing outside this file.
(HERE / "payloads.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(f"wrote {HERE / 'payloads.json'}")
