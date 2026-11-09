"""Every email and Slack message Markdrop sends, built from fixtures by the real builders.

One list (:data:`ENTRIES`) feeds the admin's message gallery (Admin › Email › Templates), the
snapshot tests (tests/test_message_templates.py), the before/after shots and the test-send script
(scripts/send_test_emails.py). Builders only: no database, no network, nothing is sent.

The fixtures are a small fictional team ("Senseloaf": Riya, Alex, Maya, Sam; Jordan from outside).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from app.config import get_settings

UID = "6aecc9488c77e564c2be27b1"
TEAM = "T0ACME"
USERS = {"U0MAYA": "Maya Patel", "U0ALEX": "Alex Chen", "U0SAM": "Sam Lee", "U0RIYA": "Riya Sharma"}


def _base() -> str:
    return get_settings().frontend_url.rstrip("/")


@dataclass
class Entry:
    id: str
    kind: str            # "email" | "slack" | "page"
    group: str           # how the gallery groups it
    name: str
    note: str            # when it's sent
    build: Callable[[], dict]


ENTRIES: list[Entry] = []


def entry(id: str, kind: str, group: str, name: str, note: str):
    def wrap(fn: Callable[[], dict]) -> Callable[[], dict]:
        ENTRIES.append(Entry(id, kind, group, name, note, fn))
        return fn
    return wrap


# ── Slack ─────────────────────────────────────────────────────────────────────


def _kit():
    from app.services import slack_blocks as kit

    return kit


def _sv(*parts: str) -> str:
    from app.services import slack

    try:
        return slack.sign_value(TEAM, *parts)
    except Exception:   # no signing secret configured (a preview): the value is never used
        return "preview|" + "|".join(parts)


MEETING_SUMMARY = (
    "The team reviewed progress on the Q3 launch. **Maya** confirmed the onboarding checklist is feature-complete "
    "and behind a flag in staging; QA starts Monday. Alex reported the annual-plan billing bug is fixed in 2.4.1 "
    "and three affected customers need to be told. Sam raised that the partner pricing sheet still lacks the EU "
    "tiers, and finance wants it before the partner review next Thursday. The group discussed whether to delay the "
    "partner review; consensus was to keep the date and send a draft first. Jordan is blocked on read-only "
    "Postgres credentials for the connector demo.")
MEETING_ITEMS = [
    {"block": "b-1a2b3c4d", "owner": "<@U0MAYA>", "owner_key": "u:maya", "text": "Update the onboarding docs before the release",
     "due": "Tue, Nov 11", "done_by": None},
    {"block": "b-2b3c4d5e", "owner": "<@U0ALEX>", "owner_key": "u:alex", "text": "Email the three affected billing customers",
     "due": "Mon, Nov 10", "done_by": None},
    {"block": "b-3c4d5e6f", "owner": "*Sam Lee*", "owner_key": "n:sam lee", "text": "Add the EU tiers to the partner pricing sheet",
     "due": "Wed, Nov 12", "done_by": None},
    {"block": "b-5e6f7081", "owner": "<@U0MAYA>", "owner_key": "u:maya", "text": "Share the QA plan in #launch", "due": None,
     "done_by": None},
    {"block": "b-4d5e6f70", "owner": "<@U0ALEX>", "owner_key": "u:alex", "text": "Create read-only Postgres credentials for Jordan",
     "due": None, "done_by": "Alex Chen"},
]


def meeting_post(items: list[dict] | None = None) -> dict:
    kit = _kit()
    return kit.meeting_post(
        TEAM, "6aecc9488c77e564c2be27a1", title="Daily Syncup", url=f"{_base()}/daily-syncup-nov-7",
        when="Fri, Nov 7 · 10:00", day="Nov 7", duration="32 min", series="Daily Syncup",
        people=["Maya Patel", "Alex Chen", "Sam Lee"], people_total=6, summary=MEETING_SUMMARY,
        decisions=["Ship the onboarding checklist on Nov 12", "Keep the old onboarding flow behind a flag for two weeks",
                   "Keep the partner review on Thursday and send a draft sheet first"],
        open_questions=["Do the EU tiers need legal review before the partner review?"],
        items=MEETING_ITEMS if items is None else items)


@entry("slack-meeting-post", "slack", "Slack · channel posts", "Meeting notes in the meetings channel",
       "When a meeting's summary is ready (or Post to Slack again)")
def _meeting_post() -> dict:
    return {"where": "#meetings", "from": "Markdrop", "message": meeting_post(), "users": USERS}


@entry("slack-meeting-post-busy", "slack", "Slack · channel posts", "Meeting notes: one person with many items",
       "Someone with three or more open items gets them under their name; at most 8 rows")
def _meeting_post_busy() -> dict:
    many = [{"block": f"b-9{i:07d}", "owner": "<@U0MAYA>", "owner_key": "u:maya", "text": t, "due": d, "done_by": None}
            for i, (t, d) in enumerate([("Write the launch email", "Mon, Nov 10"), ("Record the demo video", "Wed, Nov 12"),
                                        ("Brief support on the new flow", None)])]
    others = [{"block": f"b-8{i:07d}", "owner": o, "owner_key": k, "text": t, "due": None, "done_by": None}
              for i, (o, k, t) in enumerate([("<@U0ALEX>", "u:alex", "Check the billing migration"),
                                              ("*Sam Lee*", "n:sam", "Send finance the draft sheet"),
                                              ("<@U0ALEX>", "u:alex", "Close the old onboarding tickets"),
                                              ("*Jordan Park*", "n:jordan", "Prepare the connector demo"),
                                              ("<@U0RIYA>", "u:riya", "Book the partner review room")])]
    return {"where": "#meetings", "from": "Markdrop", "message": meeting_post(many + others), "users": USERS}


@entry("slack-meeting-post-done", "slack", "Slack · channel posts", "Meeting notes after a Done click",
       "The same post, updated in place: the item is struck through with who finished it")
def _meeting_post_done() -> dict:
    items = [dict(i) for i in MEETING_ITEMS]
    items[0]["done_by"] = "Maya Patel"
    return {"where": "#meetings", "from": "Markdrop", "message": meeting_post(items), "users": USERS}


def weekly_summary() -> dict:
    """A week of a team as sent on Monday Nov 9 (team_extras.compose(summary=True)'s shape): last week's
    highlights, decisions and meetings (Nov 2 – 8), this week's due items (Nov 9 – 15)."""
    def p(name: str) -> dict:
        return {"id": name.split()[0].lower(), "name": name, "avatar_url": None}

    def src(title: str, slug: str) -> dict:
        return {"title": title, "href": f"/{slug}"}

    return {
        "from": "2026-11-09", "to": "2026-11-15", "week": "2026-W46", "today": "2026-11-09", "window": "last_week",
        "highlights_from": "2026-11-02", "highlights_to": "2026-11-08",
        "highlights": [
            {"person": p("Maya Patel"), "text": "Shipped the onboarding checklist behind a flag", "kind": "update",
             "sources": [src("Weekly product sync", "weekly-product-sync-nov-4")]},
            {"person": p("Alex Chen"), "text": "Fixed the annual-plan billing bug in 2.4.1", "kind": "update",
             "sources": [src("Daily standup", "daily-standup-nov-5")]},
            {"person": p("Sam Lee"), "text": "Finished the partner pricing sheet draft with the EU tiers", "kind": "update",
             "sources": [src("Pricing review", "pricing-review-nov-5")]},
            {"person": p("Maya Patel"), "text": "Started QA on the new onboarding flow with two customers", "kind": "working_on",
             "sources": [src("Daily standup", "daily-standup-nov-6")]},
        ],
        "decisions": [
            {"person": p("Riya Sharma"), "text": "The partner pricing sheet goes to finance before the review",
             "source": src("Pricing review", "pricing-review-nov-5")},
            {"person": p("Alex Chen"), "text": "Keep the old onboarding flow behind a flag for two weeks",
             "source": src("Weekly product sync", "weekly-product-sync-nov-4")},
        ],
        "blockers": [{"person": p("Jordan Park"), "text": "The Postgres connector demo needs read-only credentials",
                      "waiting_on": "Alex Chen", "source": src("Daily standup", "daily-standup-nov-6")}],
        "due": [{"person": p("Maya Patel"), "text": "Update the onboarding docs", "due": "2026-11-11", "days": 2,
                 "source": src("Weekly product sync", "weekly-product-sync-nov-4")},
                {"person": p("Sam Lee"), "text": "Send the release notes to customers", "due": "2026-11-12", "days": 3,
                 "source": None}],
        "overdue": [{"person": p("Alex Chen"), "text": "Triage the crash reports from 2.4.0", "due": "2026-11-05", "days": -4,
                     "source": src("Daily standup", "daily-standup-nov-5")}],
        "meetings": [{"title": "Weekly product sync", "date": "2026-11-04", "time": "10:00", "href": "/weekly-product-sync-nov-4"},
                     {"title": "Pricing review", "date": "2026-11-05", "time": "15:30", "href": "/pricing-review-nov-5"},
                     {"title": "Daily standup", "date": "2026-11-06", "time": "09:30", "href": "/daily-standup-nov-6"}],
    }


def _ws():
    from app.services import workspace_memory as wm

    return wm.WsInfo("6aecc9488c77e564c2be27c0", "Senseloaf", True, True)


@entry("slack-team-weekly", "slack", "Slack · channel posts", "Week of Nov 9 in Senseloaf (Team's weekly summary)",
       "Monday 9:00 in the workspace's timezone, and Team › Send now")
def _team_weekly_slack() -> dict:
    from app.services import team_extras

    blocks, text = team_extras.slack_blocks(_ws(), weekly_summary())
    return {"where": "#meetings", "from": "Markdrop", "message": {"blocks": blocks, "text": text}, "users": USERS}


@entry("slack-dm-action-items", "slack", "Slack · direct messages", "Your action items after a meeting",
       "To each person with an open action item, after every meeting")
def _dm_action_items() -> dict:
    kit = _kit()
    msg = kit.dm_action_items(TEAM, "6aecc9488c77e564c2be27b0", [{
        "title": "Daily Syncup", "when": "Nov 7", "url": f"{_base()}/daily-syncup-nov-7", "organizer": None,
        "can_edit": True, "items": [
            {"block": "b-1a2b3c4d", "text": kit.esc("Update the onboarding docs before the release"),
             "due": "Tuesday (Tue, Nov 11)", "done": False},
            {"block": "b-5e6f7081", "text": kit.esc("Share the QA plan in #launch"), "due": None, "done": False},
        ]}], stop_value=_sv("stop", "U0MAYA", UID))
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-dm-action-items-outside", "slack", "Slack · direct messages", "Action items: someone outside Markdrop",
       "Only their own items and who to ask for the notes")
def _dm_action_items_outside() -> dict:
    kit = _kit()
    msg = kit.dm_action_items(TEAM, "6aecc9488c77e564c2be27b2", [{
        "title": "Daily Syncup", "when": "Nov 7", "url": None, "organizer": "Riya Sharma", "can_edit": False,
        "items": [{"block": "b-5e6f7082", "text": kit.esc("Share the partner pricing sheet with finance"),
                   "due": "Fri, Nov 7", "done": False}]}], stop_value=_sv("stop", "U0JORDAN", ""))
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-dm-mention", "slack", "Slack · direct messages", "Mention", "Someone @mentions you on a page (opt-in)")
def _dm_mention() -> dict:
    msg = _kit().dm_mention("Alex Chen", "Release notes 2.4", f"{_base()}/release-notes-2-4#b-9f8e7d6c",
                            "@Riya Sharma can you check the migration steps before we publish?", where="Senseloaf")
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-dm-signoff", "slack", "Slack · direct messages", "Sign-off request", "Someone names you on a sign-off block")
def _dm_signoff() -> dict:
    msg = _kit().dm_signoff(TEAM, "Sam Lee", "Q3 launch plan", f"{_base()}/q3-launch-plan#b-2b3c4d5e", "Go live",
                            "6aecc9488c77e564c2be27a2", "b-2b3c4d5e", ["Approved", "Changes needed"], where="Senseloaf")
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-dm-signoff-done", "slack", "Slack · direct messages", "Sign-off request, answered", "After a button click")
def _dm_signoff_done() -> dict:
    msg = _kit().dm_signoff(TEAM, None, "Q3 launch plan", f"{_base()}/q3-launch-plan#b-2b3c4d5e", "Go live",
                            "6aecc9488c77e564c2be27a2", "b-2b3c4d5e", ["Approved", "Changes needed"],
                            done="You chose *Approved*.", where="Senseloaf")
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-dm-shared", "slack", "Slack · direct messages", "Shared with you", "Someone shares a page with you (opt-in)")
def _dm_shared() -> dict:
    msg = _kit().dm_shared("Riya Sharma", "Q3 launch plan", f"{_base()}/q3-launch-plan", "editor",
                           "Can you check the pricing section before Friday?", where="Senseloaf")
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-dm-access-request", "slack", "Slack · direct messages", "Access request (Approve / Decline)",
       "Someone asks to open or edit your page (opt-in)")
def _dm_access_request() -> dict:
    msg = _kit().dm_access_request(TEAM, "Jordan Park", "jordan@northwind.com", "Q3 launch plan",
                                   f"{_base()}/requests/6aecc9488c77e564c2be2796", "6aecc9488c77e564c2be2796", True,
                                   "I'm preparing the partner review and need to add our numbers.", False)
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-dm-access-request-done", "slack", "Slack · direct messages", "Access request, decided", "After Approve")
def _dm_access_request_done() -> dict:
    msg = _kit().dm_access_request(TEAM, "Jordan Park", "jordan@northwind.com", "Q3 launch plan",
                                   f"{_base()}/requests/6aecc9488c77e564c2be2796", "6aecc9488c77e564c2be2796", True,
                                   "I'm preparing the partner review and need to add our numbers.", False,
                                   done="Approved by you: they can edit it now.")
    return {"where": "Direct message", "from": "Markdrop", "message": msg, "users": USERS}


@entry("slack-search", "slack", "Slack · /markdrop", "/markdrop search", "Only the person who asked sees it")
def _search() -> dict:
    b = _base()
    msg = _kit().search_results("onboarding", [
        {"title": "Onboarding guide", "kind": "page", "web_url": f"{b}/onboarding-guide", "workspace": {"name": "Senseloaf"},
         "snippet": {"text": "Everything a new teammate needs in their first week: accounts, tools and who to ask."}},
        {"title": "Onboarding handbook", "kind": "file", "type_label": "PDF", "web_url": f"{b}/onboarding-handbook",
         "workspace": {"name": "Senseloaf"}, "snippet": {"text": "Benefits, time off and the team calendar."}},
        {"title": "Getting started", "kind": "doc", "web_url": f"{b}/getting-started", "workspace": {"name": "Senseloaf"},
         "snippet": {"text": "Install the CLI, connect a data source and invite your team."}},
    ], more_url=f"{b}/search?q=onboarding")
    return {"where": "/markdrop search onboarding", "from": "Markdrop", "ephemeral": True, "message": msg, "users": USERS}


@entry("slack-ask", "slack", "Slack · /markdrop", "/markdrop ask", "An AI answer with sources, only for the person who asked")
def _ask() -> dict:
    b = _base()
    msg = _kit().answer(
        "How do I connect Postgres?",
        "Create a read-only user in Postgres, then add it under Settings › Data sources › Postgres with the host, port "
        "and database [1]. Connections come from two fixed IP addresses you can allow in your firewall [2].",
        [{"n": 1, "title": "Connect Postgres", "url": f"{b}/connect-postgres"},
         {"n": 2, "title": "Security FAQ", "url": f"{b}/security-faq"}])
    return {"where": "/markdrop ask How do I connect Postgres?", "from": "Markdrop", "ephemeral": True, "message": msg,
            "users": USERS}


@entry("slack-help", "slack", "Slack · /markdrop", "/markdrop help", "/markdrop with nothing after it, or help")
def _help() -> dict:
    return {"where": "/markdrop help", "from": "Markdrop", "ephemeral": True, "message": _kit().help_message("Riya Sharma"),
            "users": USERS}


@entry("slack-unfurl", "slack", "Slack · /markdrop", "Link preview (unfurl)", "A markdrop.in link the channel may open")
def _unfurl() -> dict:
    b = _base()
    msg = _kit().item_unfurl(f"{b}/connect-postgres", "Connect Postgres", kind="Page",
                             excerpt="Create a read-only user, add it under Settings › Data sources, and check the "
                                     "connection. Takes about five minutes.", where="Senseloaf", updated="Nov 3, 2026")
    return {"where": "#product", "from": "Alex Chen", "message": msg, "users": USERS,
            "unfurl_of": f"{b}/connect-postgres"}


@entry("slack-unfurl-minimal", "slack", "Slack · /markdrop", "Link preview, not for everyone",
       "A link some of the channel can't open: no title, no text")
def _unfurl_minimal() -> dict:
    b = _base()
    return {"where": "#product", "from": "Alex Chen", "message": _kit().minimal_unfurl(f"{b}/q3-plan-internal"),
            "users": USERS, "unfurl_of": f"{b}/q3-plan-internal"}


# ── Email ─────────────────────────────────────────────────────────────────────


def _m():
    from app.services import mailer

    return mailer


def _mail(sender: str, mail: dict) -> dict:
    return {**mail, "from": _m()._sender(sender)}


@entry("email-login", "email", "Email · account", "Sign-in code", "Someone asks to sign in (login@)")
def _e_login() -> dict:
    return _mail("login", _m().compose_login("482913", f"{_base()}/auth/verify?t=preview"))


@entry("email-welcome", "email", "Email · account", "Welcome", "Once, on sign-up")
def _e_welcome() -> dict:
    return _mail("welcome", _m().compose_welcome("Riya"))


@entry("email-invite", "email", "Email · account", "Workspace invitation", "An admin invites someone to a workspace")
def _e_invite() -> dict:
    return _mail("share", _m().compose_invite("Senseloaf", "Riya Sharma", "member", f"{_base()}/invite/preview"))


@entry("email-share", "email", "Email · sharing", "Shared with you", "Someone shares a page with you (Notify people)")
def _e_share() -> dict:
    return _mail("share", _m().compose_share(document_title="Q3 launch plan", url=f"{_base()}/q3-launch-plan",
                                             sharer_name="Riya Sharma", role="editor", encrypted=False,
                                             message="Can you check the pricing section before Friday?", noun="page"))


@entry("email-share-encrypted", "email", "Email · sharing", "Shared with you: an encrypted document",
       "The same, for an end-to-end encrypted document")
def _e_share_enc() -> dict:
    return _mail("share", _m().compose_share(document_title="Board memo", url=f"{_base()}/board-memo",
                                             sharer_name="Riya Sharma", role="viewer", encrypted=True, message=None))


@entry("email-access-request", "email", "Email · sharing", "Access request", "Someone asks to open your document")
def _e_access_request() -> dict:
    return _mail("share", _m().compose_access_request(
        requester_name="Jordan Park", requester_email="jordan@northwind.com", document_title="Q3 launch plan",
        message="I'm preparing the partner review and need the numbers.", request_id="6aecc9488c77e564c2be2796",
        workspace_name="Senseloaf"))


@entry("email-edit-request", "email", "Email · sharing", "Edit access request (to the workspace's admins)",
       "A reader asks to edit a page whose owner can't be reached")
def _e_edit_request() -> dict:
    return _mail("share", _m().compose_edit_request(
        requester_name="Jordan Park", requester_email="jordan@northwind.com", document_title="Q3 launch plan",
        message="I need to add our partner numbers.", request_id="6aecc9488c77e564c2be2796", as_admin=True,
        workspace_name="Senseloaf"))


@entry("email-access-approved", "email", "Email · sharing", "Access approved", "The owner said yes")
def _e_approved() -> dict:
    return _mail("share", _m().compose_access_decision(owner_name="Riya Sharma", document_title="Q3 launch plan",
                                                       url=f"{_base()}/q3-launch-plan", approved=True, role="viewer"))


@entry("email-access-declined", "email", "Email · sharing", "Access declined", "The owner said no")
def _e_declined() -> dict:
    return _mail("share", _m().compose_access_decision(owner_name="Riya Sharma", document_title="Q3 launch plan",
                                                       url=f"{_base()}/q3-launch-plan", approved=False, role=None))


@entry("email-admin-added", "email", "Email · admin console", "Admin added (to owners)",
       "An owner made someone an admin; every owner gets this")
def _e_admin_added() -> dict:
    return _mail("share", _m().compose_admin_change(actor="Riya Sharma", actor_email="riya@senseloaf.com",
                                                    target="alex@senseloaf.com", added=True, note="Runs support"))


@entry("email-admin-removed", "email", "Email · admin console", "Admin removed (to owners)",
       "An owner removed an admin; every owner gets this")
def _e_admin_removed() -> dict:
    return _mail("share", _m().compose_admin_change(actor="Riya Sharma", actor_email="riya@senseloaf.com",
                                                    target="alex@senseloaf.com", added=False, note=None))


@entry("email-admin-granted", "email", "Email · admin console", "You're now an admin",
       "To the person an owner just made an admin")
def _e_admin_granted() -> dict:
    return _mail("share", _m().compose_admin_granted(actor="Riya Sharma", has_account=True, name="Alex Chen"))


def _items():
    return [{"kind": "mention", "actor": "Alex Chen", "block": "b-1a2b3c4d",
             "excerpt": "@Riya Sharma can you check the migration steps before we publish?", "label": None},
            {"kind": "signoff_requested", "actor": "Sam Lee", "block": "b-2b3c4d5e", "excerpt": None, "label": "Go live"},
            {"kind": "mention", "actor": "Maya Patel", "block": "b-3c4d5e6f",
             "excerpt": "Pricing numbers are in, @Riya Sharma please confirm the EU tiers.", "label": None}]


def _less() -> str:
    from app.services import notifications as n

    return n.less_url(UID, {"mention": "hourly"}) or ""


@entry("email-mention", "email", "Email · notifications", "Mention (instant)", "Someone @mentions you; Instant setting")
def _e_mention() -> dict:
    from app.services import notifications as n

    return _mail("share", n.compose_email(user_id=UID, title="Release notes 2.4", page_url=f"{_base()}/release-notes-2-4",
                                          items=_items()[:1], why=n.WHY["instant"], less=_less()))


@entry("email-signoff", "email", "Email · notifications", "Sign-off request (instant)", "Someone asks for your sign-off")
def _e_signoff() -> dict:
    from app.services import notifications as n

    return _mail("share", n.compose_email(user_id=UID, title="Q3 launch plan", page_url=f"{_base()}/q3-launch-plan",
                                          items=_items()[1:2], why=n.WHY["instant"], less=_less()))


@entry("email-mentions-page", "email", "Email · notifications", "Several updates on one page", "Batched for one page")
def _e_mentions_page() -> dict:
    from app.services import notifications as n

    return _mail("share", n.compose_email(user_id=UID, title="Q3 launch plan", page_url=f"{_base()}/q3-launch-plan",
                                          items=_items(), more=2, why=n.WHY["hourly"], less=_less()))


def _pages():
    b = _base()
    it = _items()
    return [{"title": "Q3 launch plan", "url": f"{b}/q3-launch-plan", "items": it[:2], "more": 0, "more_signoffs": 0},
            {"title": "Release notes 2.4", "url": f"{b}/release-notes-2-4", "items": it[2:], "more": 2, "more_signoffs": 0}]


@entry("email-hourly", "email", "Email · notifications", "Hourly bundle", "Mentions' default: at most one an hour")
def _e_hourly() -> dict:
    from app.services import notifications as n

    return _mail("share", n.compose_digest(user_id=UID, pages=_pages(), mode="hourly", less=_less()))


@entry("email-daily", "email", "Email · notifications", "Daily digest", "08:00 in the person's timezone")
def _e_daily() -> dict:
    from app.services import notifications as n

    return _mail("share", n.compose_digest(user_id=UID, pages=_pages(), mode="daily", more_pages=1, less=_less()))


@entry("email-catchup", "email", "Email · notifications", "Morning catch-up", "What waited past the daily cap of 3")
def _e_catchup() -> dict:
    from app.services import notifications as n

    return _mail("share", n.compose_digest(user_id=UID, pages=_pages(), mode="catchup", catchup=True))


@entry("email-team-weekly", "email", "Email · digests", "Week of Nov 9: last week's highlights and what's due (Team's weekly summary)",
       "Monday 9:00 to the workspace's admins, and Team › Send now")
def _e_team_weekly() -> dict:
    from app.services import team_extras

    return _mail("share", team_extras.compose_email(_ws(), weekly_summary()))


@entry("email-analytics-weekly", "email", "Email · digests", "Your week (analytics)", "Monday, when your links had views")
def _e_analytics() -> dict:
    from app.services import analytics_digest as ad

    b = _base()
    head, sub = "Your week: 1,284 views, up 18%", "Oct 27 – Nov 2 · your own views aren't counted"
    args = (head, sub, [("People", "642"), ("Watch time", "3 h 12 min"), ("Read to the end", "38%")],
            [{"slug": "q3-launch-plan", "title": "Q3 launch plan", "views": 640, "pct": 100, "note": "Most from LinkedIn"},
             {"slug": "release-notes-2-4", "title": "Release notes 2.4", "views": 312, "pct": 49, "note": None},
             {"slug": "onboarding-video", "title": "Onboarding video", "views": 148, "pct": 23, "note": "Watched 61% on average"}],
            [{"title": "Readers stop at the pricing table", "body": "Half of readers leave at Pricing; a summary above "
              "it may help.", "doc": "Q3 launch plan"}],
            f"{b}/dashboard/analytics", "https://api.markdrop.in/api/v1/me/digest/off?t=preview",
            {"headline": "LinkedIn drove the jump", "bullets": [
                {"text": "Q3 launch plan doubled after Tuesday's LinkedIn post.", "href": "/dashboard/analytics/q3-launch-plan"},
                {"text": "Release notes 2.4 kept a steady 40 views a day.", "href": ""}]})
    e = ad._email(*args)
    return {"subject": "Your Markdrop week: 1,284 views, up 18%", "preheader": f"{head}. {sub}.", "html": e.html,
            "text": e.text, "from": _m()._sender("welcome")}


@entry("email-guide-domain-live", "email", "Email · Guides", "A guide's domain is live", "Its certificate is issued")
def _e_domain_live() -> dict:
    return _mail("share", _m().compose_guide_domain(host="docs.acme.com", guide_name="Acme Docs", live=True,
                                                    settings_url=f"{_base()}/guides", message=None))


@entry("email-guide-domain-failed", "email", "Email · Guides", "A guide's domain isn't live", "Checks gave up after 3 days")
def _e_domain_failed() -> dict:
    return _mail("share", _m().compose_guide_domain(host="docs.acme.com", guide_name="Acme Docs", live=False,
                                                    settings_url=f"{_base()}/guides", message="No CNAME record found for docs.acme.com."))


@entry("email-guide-signin", "email", "Email · Guides", "Guide sign-in link", "A reader signs in to a gated guide")
def _e_guide_signin() -> dict:
    return _mail("login", _m().compose_guide_signin(to="jordan@northwind.com", guide="Acme Docs",
                                                    url="https://docs.acme.com/_signin?t=preview"))


@entry("email-guide-access-request", "email", "Email · Guides", "Guide access request", "To the guide's admins")
def _e_guide_req() -> dict:
    return _mail("share", _m().compose_guide_access_request(guide="Acme Docs", email="jordan@northwind.com",
                                                            rule_name="Partners", note="Our team needs the API pages.",
                                                            url=f"{_base()}/guides"))


@entry("email-guide-access-approved", "email", "Email · Guides", "Guide access approved", "To the reader")
def _e_guide_ok() -> dict:
    return _mail("share", _m().compose_guide_access_decision(guide="Acme Docs", approved=True, url="https://docs.acme.com"))


@entry("page-unsubscribed", "page", "Pages an email links to", "Unsubscribed", "After the unsubscribe link")
def _p_unsub() -> dict:
    return {"subject": None, "html": _m().unsubscribe_page_html(True), "text": None}


# ── Rendering ─────────────────────────────────────────────────────────────────


def get(entry_id: str) -> Entry | None:
    return next((e for e in ENTRIES if e.id == entry_id), None)


def render(e: Entry) -> dict[str, Any]:
    """An entry as the gallery shows it: emails {subject, preheader, html, text, bytes}; Slack messages
    {message, html_light, html_dark, blocks, text}."""
    from app.services import slack_preview

    out: dict[str, Any] = {"id": e.id, "kind": e.kind, "group": e.group, "name": e.name, "note": e.note}
    got = e.build()
    if e.kind == "slack":
        msg = got["message"]
        kw = dict(where=got.get("where", ""), sender=got.get("from", "Markdrop"), ephemeral=got.get("ephemeral", False),
                  users=got.get("users") or USERS, unfurl_of=got.get("unfurl_of"))
        out.update(message=msg, blocks=len(msg.get("blocks") or []), text=msg.get("text"),
                   html_light=slack_preview.page(msg, theme="light", **kw),
                   html_dark=slack_preview.page(msg, theme="dark", **kw))
    else:
        out.update(subject=got.get("subject"), preheader=got.get("preheader"), html=got["html"], text=got.get("text"),
                   sender=got.get("from"), bytes=len(got["html"].encode()))
    return out
