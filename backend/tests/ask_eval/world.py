"""The Ask Markdrop eval world: a realistic team ("Acme Labs") with ~18 meetings, pages and documents.

Dates are relative to today (``D(n)`` = n days ago) so relative questions ("yesterday", "my last
sync-up") stay true whenever the eval runs. Meeting notes are fixed here (the summary model call is
always answered from :data:`MEETINGS`), so only the *asking* calls reach the model under test.

People (Slack-style speaker names in transcripts, matched by the import's people matcher):
  hk      Himanshu Kukreja   owner of Acme Labs (the main asker; speaks as "Himanshu" or full name)
  aarav   Aarav Mehta        admin
  priya   Priya Nair         member  (speaks as "priya.nair")
  rohan   Rohan Gupta        member  (speaks as "rohan.g", his email's local part)
  sneha   Sneha Iyer         member
  vikram  Vikram Rao         viewer
  kabir   Kabir Singh        not a member (Senseloaf, a customer)
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone

from bson import ObjectId

PEOPLE = {
    "hk": ("Himanshu Kukreja", "himanshu@acmelabs.test"),
    "aarav": ("Aarav Mehta", "aarav@acmelabs.test"),
    "priya": ("Priya Nair", "priya.nair@acmelabs.test"),
    "rohan": ("Rohan Gupta", "rohan.g@acmelabs.test"),
    "sneha": ("Sneha Iyer", "sneha@acmelabs.test"),
    "vikram": ("Vikram Rao", "vikram@acmelabs.test"),
    "kabir": ("Kabir Singh", "kabir@senseloaf.test"),
}
ROLES = {"aarav": "admin", "priya": "member", "rohan": "member", "sneha": "member", "vikram": "viewer"}


def today() -> date:
    return datetime.now(timezone.utc).date()


def D(n: int) -> str:
    return (today() - timedelta(days=n)).isoformat()


def fmt(d: str) -> str:
    x = date.fromisoformat(d)
    return f"{x.strftime('%b')} {x.day}"


SYNC_ATT = "Attendees: Himanshu Kukreja, Aarav Mehta, Priya Nair, Rohan Gupta, Sneha Iyer"


def _g(summary: str, decisions=(), actions=(), questions=(), topics=(), type_: str = "Standup") -> dict:
    return {"summary": summary, "highlights": [],
            "decisions": [{"text": d, "cite": "s2"} for d in decisions],
            "action_items": [{"text": t, "owner": o, "due": due, "cite": "s2"} for o, t, due in actions],
            "open_questions": [{"text": q, "cite": "s1"} for q in questions],
            "topics": [{"title": t, "gist": g, "cite": "s1"} for t, g in topics], "type": type_}


# (key, title, days ago, series, restricted, lines, generated notes)
MEETINGS: list[dict] = [
    {"key": "sync8", "title": "Daily Syncup", "ago": 8, "series": "Daily Syncup", "lines": [
        SYNC_ATT,
        "Aarav Mehta: Morning everyone, quick round.",
        "Himanshu: I'm finishing the Slack app OAuth flow, it should be done by Wednesday.",
        "rohan.g: The rate limiter design doc is up for review.",
        "priya.nair: Onboarding email copy is ready for review.",
        "Sneha Iyer: I'm still on the home redesign explorations."],
     "gen": _g("Round of updates: Slack OAuth, rate limiter design, onboarding emails.",
               actions=[("Aarav Mehta", "Review the rate limiter design doc", None)])},
    {"key": "sync7", "title": "Daily Syncup", "ago": 7, "series": "Daily Syncup", "lines": [
        SYNC_ATT,
        "Himanshu Kukreja: Slack OAuth is done. Next I'm on the meetings import from Google Drive.",
        "Aarav Mehta: The pricing page experiment is live with a 50/50 split.",
        "Sneha Iyer: The new home design is in Figma, please comment by Friday.",
        "rohan.g: Reviewing the rate limiter comments today."],
     "gen": _g("Slack OAuth done; pricing experiment live; home design in Figma.",
               actions=[("Priya Nair", "Comment on the new home design in Figma", "Friday")])},
    {"key": "sync6", "title": "Daily Syncup", "ago": 6, "series": "Daily Syncup", "lines": [
        SYNC_ATT,
        "Himanshu: Drive import works for Google Docs now, Sheets will come later.",
        "rohan.g: The rate limiter is merged: 100 requests per minute per token.",
        "priya.nair: Haan, onboarding emails ka A/B test kal se start hoga, variant B has the shorter subject line.",
        "Aarav Mehta: Nice. Let's track activation for both variants."],
     "gen": _g("Drive import for Docs; rate limiter merged at 100/min; onboarding A/B test starts tomorrow.",
               decisions=["The API rate limit is 100 requests per minute per token."])},
    {"key": "sync3", "title": "Daily Syncup", "ago": 3, "series": "Daily Syncup", "lines": [
        SYNC_ATT,
        "Himanshu: I fixed the search ranking bug for transcripts, deploying tonight.",
        "Aarav Mehta: The Senseloaf call moved to Thursday.",
        "Sneha Iyer: Home redesign review is today at 4.",
        "priya.nair: Activation numbers from the A/B test come in tomorrow."],
     "gen": _g("Search ranking fix; Senseloaf call moved; home redesign review today.")},
    {"key": "sync2", "title": "Daily Syncup", "ago": 2, "series": "Daily Syncup", "lines": [
        SYNC_ATT,
        "Himanshu Kukreja: The search fix is live. I'll write the Ask Markdrop docs today.",
        "rohan.g: We're seeing 429 errors from the export API for big workspaces.",
        "priya.nair: Onboarding A/B: variant B has 18% higher activation than A.",
        "Aarav Mehta: Great result. Rohan, can you look at the 429s first thing?",
        "rohan.g: Yes, I'll take it."],
     "gen": _g("Search fix live; export API 429s for big workspaces; variant B +18% activation.",
               actions=[("Rohan Gupta", "Investigate the 429 errors from the export API", None),
                        ("Himanshu Kukreja", "Write the Ask Markdrop docs", None)])},
    {"key": "sync1", "title": "Daily Syncup", "ago": 1, "series": "Daily Syncup", "lines": [
        SYNC_ATT,
        "Himanshu: I'm pairing with Rohan on the 429s, we'll raise the export limit to 300 requests per minute.",
        "Himanshu: Also, I need someone to review the meetings privacy doc.",
        "Sneha Iyer: I can review the privacy doc this afternoon.",
        "Aarav Mehta: The Q4 roadmap review is on Friday, please update your sections.",
        "priya.nair: Will do."],
     "gen": _g("Export limit to go to 300/min; privacy doc review; Q4 roadmap review Friday.",
               decisions=["Raise the export API limit to 300 requests per minute."],
               actions=[("Sneha Iyer", "Review the meetings privacy doc", "today"),
                        ("Himanshu Kukreja", "Update the Slack app section of the Q4 roadmap", "Friday")])},
    {"key": "sync0", "title": "Daily Syncup", "ago": 0, "series": "Daily Syncup", "lines": [
        SYNC_ATT,
        "Aarav Mehta: Himanshu is on leave this afternoon, so let's keep it short.",
        "rohan.g: The export limit is raised to 300 per minute, no more 429s since last night.",
        "priya.nair: Variant B is now the default onboarding email.",
        "Sneha Iyer: Privacy doc reviewed, two small comments left in it."],
     "gen": _g("Export limit at 300/min, 429s gone; variant B default; privacy doc reviewed.",
               decisions=["Variant B is the default onboarding email."])},
    {"key": "oneone", "title": "Himanshu / Aarav 1:1", "ago": 4, "series": "Himanshu / Aarav 1:1", "restricted": True, "lines": [
        "Attendees: Himanshu Kukreja, Aarav Mehta",
        "Aarav Mehta: I'd like to move to the platform team next quarter.",
        "Himanshu: That works. Let's plan the handover of pricing to Sneha by mid December.",
        "Aarav Mehta: I'll write the handover doc."],
     "gen": _g("Aarav wants to move to the platform team; pricing handover to Sneha.", type_="1:1",
               actions=[("Aarav Mehta", "Write the pricing handover doc", "mid December")])},
    {"key": "oneone_p", "title": "Himanshu / Priya 1:1", "ago": 9, "series": "Himanshu / Priya 1:1", "restricted": True, "lines": [
        "Attendees: Himanshu Kukreja, Priya Nair",
        "priya.nair: I'd like to own the onboarding funnel metrics end to end.",
        "Himanshu: Agreed, you own the funnel dashboard from now on."],
     "gen": _g("Priya owns the onboarding funnel metrics.", type_="1:1",
               decisions=["Priya owns the onboarding funnel dashboard."])},
    {"key": "hiring", "title": "Hiring plan Q1", "ago": 5, "series": None, "restricted": True, "lines": [
        "Attendees: Himanshu Kukreja, Sneha Iyer",
        "Himanshu: We will hire two backend engineers in Q1 with a budget of 45 lakh.",
        "Sneha Iyer: I'll draft the job descriptions this week."],
     "gen": _g("Two backend hires in Q1 with a budget of 45 lakh.", type_="Planning",
               decisions=["Hire two backend engineers in Q1 with a budget of 45 lakh."],
               actions=[("Sneha Iyer", "Draft the backend job descriptions", "this week")])},
    {"key": "sprint22", "title": "Sprint 22 planning", "ago": 10, "series": "Sprint planning", "lines": [
        SYNC_ATT,
        "Aarav Mehta: Sprint 22 goals: Slack OAuth, the rate limiter, and onboarding emails.",
        "Himanshu: I'll own Slack OAuth.",
        "rohan.g: I'll take the rate limiter."],
     "gen": _g("Sprint 22: Slack OAuth, rate limiter, onboarding emails.", type_="Planning",
               decisions=["Sprint 22 goals are Slack OAuth, the rate limiter and onboarding emails."])},
    {"key": "sprint23", "title": "Sprint 23 planning", "ago": 2, "series": "Sprint planning", "lines": [
        SYNC_ATT,
        "Aarav Mehta: Sprint 23 goals: ship the Slack app beta and fix the export API limits.",
        "Himanshu Kukreja: I commit to the Slack app beta by next Friday.",
        "rohan.g: Export limits are mine.",
        "Sneha Iyer: I'll finish the home redesign handoff."],
     "gen": _g("Sprint 23: Slack app beta, export API limits, home redesign handoff.", type_="Planning",
               decisions=["Sprint 23 goals are the Slack app beta and the export API limits."],
               actions=[("Himanshu Kukreja", "Ship the Slack app beta", "next Friday"),
                        ("Rohan Gupta", "Fix the export API limits", None),
                        ("Sneha Iyer", "Finish the home redesign handoff", None)])},
    {"key": "pricing", "title": "Pricing review", "ago": 11, "series": None, "lines": [
        "Attendees: Himanshu Kukreja, Aarav Mehta, Priya Nair",
        "Aarav Mehta: I propose 20 percent off for annual plans.",
        "Himanshu: Agreed. I'd keep the free tier at 3 workspaces.",
        "priya.nair: And Pro at 12 dollars per user per month.",
        "Aarav Mehta: Decided then: 20 percent annual discount, Pro at 12 dollars, free tier stays at 3 workspaces."],
     "gen": _g("Pricing: annual discount, Pro price, free tier.", type_="Review",
               decisions=["Annual plans get a 20 percent discount.", "Pro costs 12 dollars per user per month.",
                          "The free tier stays at 3 workspaces."],
               actions=[("Aarav Mehta", "Update the pricing page", None)])},
    {"key": "senseloaf", "title": "Senseloaf customer call", "ago": 4, "series": None, "lines": [
        "Attendees: Himanshu Kukreja, Aarav Mehta, Kabir Singh",
        "Kabir Singh: We need SSO before we roll out to 200 seats.",
        "Himanshu: SSO is planned for December.",
        "Aarav Mehta: We can extend your pilot by 30 days until then.",
        "Kabir Singh: That works for us."],
     "gen": _g("Senseloaf needs SSO before 200 seats; pilot extended 30 days.", type_="Customer",
               decisions=["Extend the Senseloaf pilot by 30 days."],
               actions=[("Himanshu Kukreja", "Send Senseloaf the SSO timeline", None)])},
    {"key": "retro", "title": "Incident retro: export outage", "ago": 5, "series": None, "lines": [
        "Attendees: Himanshu Kukreja, Rohan Gupta, Priya Nair",
        "rohan.g: Root cause was a missing index on the exports collection.",
        "Himanshu: I'll add the index migration to the release checklist.",
        "rohan.g: I'll add an alert on p95 export latency.",
        "priya.nair: I'll write the customer-facing incident note."],
     "gen": _g("Export outage: missing index; alert and incident note.", type_="Review",
               decisions=["Root cause: a missing index on the exports collection."],
               actions=[("Rohan Gupta", "Add an alert on p95 export latency", None),
                        ("Priya Nair", "Write the customer-facing incident note", None),
                        ("Himanshu Kukreja", "Add the index migration to the release checklist", None)])},
    {"key": "design", "title": "Home redesign review", "ago": 3, "series": None, "lines": [
        "Attendees: Sneha Iyer, Aarav Mehta, Priya Nair",
        "Sneha Iyer: The new home puts Ask Markdrop at the top and recent meetings below.",
        "Aarav Mehta: Love it. Ship it behind a flag first.",
        "priya.nair: Can we keep the action items card?"],
     "gen": _g("New home: Ask at the top, recent meetings below; behind a flag.", type_="Review",
               decisions=["Ship the new home behind a feature flag first."],
               questions=["Do we keep the action items card on the new home?"])},
    {"key": "allhands", "title": "Monthly all hands", "ago": 12, "series": "All hands", "lines": [
        "Attendees: Himanshu Kukreja, Aarav Mehta, Priya Nair, Rohan Gupta, Sneha Iyer, Vikram Rao",
        "Himanshu: We crossed 1,000 weekly active workspaces this month.",
        "Aarav Mehta: Revenue grew 12 percent month over month.",
        "Vikram Rao: Support tickets are down 30 percent."],
     "gen": _g("1,000 weekly active workspaces; revenue +12%; tickets -30%.", type_="Other")},
]

GEMINI_NOTES = """Notes by Gemini
Summary
The marketing team planned the launch of Ask Markdrop. The blog post goes out next Tuesday and the webinar is on the 20th.
Details
Launch blog: Priya Nair will write the launch blog post for Ask Markdrop, publishing next Tuesday.
Webinar: Aarav Mehta will host a webinar on the 20th; registrations open Monday.
Suggested next steps
Priya Nair will publish the Ask Markdrop launch blog post next Tuesday.
Aarav Mehta will open the webinar registrations on Monday."""


# Noise: older meetings and documents, so retrieval works on a realistic amount (and old values compete
# with current ones: the API limit was 50/min a month ago, 100 since the rate limiter, export 300 now).
_NOISE_LINES = [
    ("Himanshu", "I'm on the billing migration cleanup, nothing blocking."),
    ("Himanshu", "Reviewing PRs today, then the editor toolbar bugs."),
    ("Himanshu Kukreja", "Working on the CLI login flow."),
    ("rohan.g", "The API rate limit is still 50 requests per minute, we should revisit it."),
    ("rohan.g", "Looking at slow queries on the documents collection."),
    ("priya.nair", "Writing the help center articles for workspaces."),
    ("priya.nair", "Onboarding survey results are in, people want templates."),
    ("Aarav Mehta", "Customer interviews this week, three scheduled."),
    ("Aarav Mehta", "Pricing research: competitors charge 10 to 15 dollars per user."),
    ("Sneha Iyer", "Working on icons for the new editor."),
    ("Sneha Iyer", "User testing sessions for the sidebar on Thursday."),
]


def noise_meetings() -> list[dict]:
    out = []
    for i, ago in enumerate(range(14, 75, 2)):
        lines = [SYNC_ATT, "Aarav Mehta: Morning, let's go round."]
        for k in range(4):
            sp, text = _NOISE_LINES[(i * 3 + k * 5) % len(_NOISE_LINES)]
            lines.append(f"{sp}: {text}")
        out.append({"key": f"old{ago}", "title": "Daily Syncup", "ago": ago, "series": "Daily Syncup", "lines": lines,
                    "gen": _g("A routine round of updates.")})
    for n, ago in ((21, 17), (20, 31), (19, 45)):
        out.append({"key": f"sprint{n}", "title": f"Sprint {n} planning", "ago": ago, "series": "Sprint planning", "lines": [
            SYNC_ATT, f"Aarav Mehta: Sprint {n} goals: editor polish and the CLI.", "Himanshu: I'll take the CLI login flow."],
            "gen": _g(f"Sprint {n}: editor polish, CLI.", type_="Planning",
                      decisions=[f"Sprint {n} goals are editor polish and the CLI."])})
    return out


NOISE_DOCS = [(f"note-{i}", f"{t} notes {i}", f"# {t} notes {i}\n\n{b}") for i, (t, b) in enumerate([
    ("Editor", "Toolbar ideas: headings, lists, code blocks."), ("CLI", "The CLI logs in with a device code."),
    ("Billing", "Invoices are generated on the 1st of each month."), ("Support", "Response time target is 4 hours."),
    ("Hiring", "Interview loop: screen, take-home, panel."), ("Design", "Spacing scale is 4px based."),
    ("Infra", "Backups run nightly at 02:00 UTC."), ("Security", "Tokens rotate every 90 days."),
    ("Marketing", "Newsletter goes out every other Thursday."), ("Research", "Users want templates and faster search."),
    ("Legal", "DPA template lives in the shared drive."), ("Sales", "Pilot length is 30 days by default."),
] * 3)]


def gen_for(title: str, day: str) -> dict | None:
    for m in [*MEETINGS, *noise_meetings()]:
        if m["title"] == title and D(m["ago"]) == day:
            return m["gen"]
    return None


def fake_generate(params: dict) -> str:
    """The summary call of an import: the fixed notes of that meeting."""
    system = params["system"][0]["text"]
    user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
    if system.startswith("You read Google's meeting notes"):
        return json.dumps({"decisions": [{"text": "Publish the Ask Markdrop launch blog next Tuesday."}],
                           "open_questions": [], "topics": [{"title": "Ask Markdrop launch", "gist": "Blog and webinar."}],
                           "type": "Planning"})
    t = re.search(r"Title: ([^\n]+)", user)
    d = re.search(r"Date: ([0-9-]{10})", user)
    g = gen_for(t.group(1).strip() if t else "", d.group(1) if d else "")
    return json.dumps(g or _g("A meeting."))


def is_generate(params: dict) -> bool:
    s = params["system"][0]["text"]
    return s.startswith(("You write the team's notes", "You merge partial", "You read Google's meeting notes"))


async def seed(w, *, noise: bool = True) -> dict:
    """Build the world on ``w`` (an AccessWorld). Returns ids: users, workspace, meetings, docs."""
    from app.services import search_index

    now = datetime.now(timezone.utc)
    ids: dict = {"meetings": {}, "docs": {}}
    for key, (name, email) in PEOPLE.items():
        w.email[key] = email
        w.uid[key] = await w.make_user(email, name)
        await w.db["users"].update_one({"_id": ObjectId(w.uid[key])}, {"$set": {"email_tz": "Asia/Kolkata"}})
    w.ws["ACME"] = await w.make_workspace("Acme Labs", "hk", require_auth=False)
    w.ws["LAB"] = await w.make_workspace("Personal Lab", "hk", require_auth=False)
    for key, role in ROLES.items():
        await w.add_member("ACME", key, role)
    await w.add_member("LAB", "priya", "member")
    for k in PEOPLE:
        await w.db["memberships"].update_many({"user_id": w.uid[k]}, {"$set": {"name": PEOPLE[k][0]}})
    ws = w.ws["ACME"]
    ids["workspace"] = ws

    async def imp(title: str, day: str, text: str, restricted: bool, who: str = "hk", name: str | None = None) -> dict:
        r = await w.http.post("/api/v1/meetings/import", headers=w.session(who), json={
            "workspace": ws, "sources": [{"name": name or title, "text": text}], "title": title, "date": day,
            "wait": True, "restricted": restricted})
        assert r.status_code == 200, r.text
        return r.json()["meetings"][0]

    for m in [*MEETINGS, *(noise_meetings() if noise else [])]:
        day = D(m["ago"])
        got = await imp(m["title"], day, "\n".join(m["lines"]), bool(m.get("restricted")))
        await w.db["meetings"].update_one({"_id": ObjectId(got["id"])}, {"$set": {"series": m.get("series")}})
        ids["meetings"][m["key"]] = got
    got = await imp("Marketing sync", D(13), GEMINI_NOTES, False, who="priya", name="Notes by Gemini")
    ids["meetings"]["marketing"] = got

    def person(k: str) -> str:
        return f':person[{PEOPLE[k][0]}]{{id="{w.uid[k]}"}}'

    async def doc(key: str, owner: str, title: str, content: str, *, editor: str = "markdown", state: str = "W",
                  created_ago: int = 5, updated_ago: int = 1, slug: str | None = None) -> dict:
        d = await w.mkdoc(state, owner=owner, ws="ACME", slug=slug or key, title=title, content=content,
                          editor=editor, grants=False, created_at=now - timedelta(days=created_ago),
                          updated_at=now - timedelta(days=updated_ago))
        await search_index.index_doc(w.db, d["_id"])
        ids["docs"][key] = d
        return d

    await doc("q4-roadmap", "aarav", "Q4 Roadmap", f"""# Q4 Roadmap

## Priorities
1. Slack app beta
2. Export API reliability
3. Onboarding activation

## Owners
- [ ] {person('hk')} Ship the Slack app beta :date[{D(-8)}]
- [ ] {person('rohan')} Raise the export API limits and add p95 alerts
- [ ] {person('priya')} Roll out onboarding variant B to everyone
- [ ] {person('sneha')} Hand off the home redesign to engineering
- [x] {person('hk')} Finish Slack OAuth
""", editor="blocks", created_ago=20, updated_ago=1)
    await doc("release-v23", "hk", "Release checklist v2.3", f"""# Release checklist v2.3

- [x] Index migration for the exports collection
- [ ] {person('rohan')} p95 export latency alert
- [ ] {person('hk')} Release notes for v2.3

:::signoff{{#b-rel23 person="{w.uid['hk']}" label="Release approval" options="Approved for production|Not approved"}}
v2.3 to production.
:::
""", editor="blocks", created_ago=4, updated_ago=1)
    await w.db["signoffs"].insert_one({"doc_id": str(ids["docs"]["release-v23"]["_id"]), "block_id": "b-rel23",
                                       "person_id": w.uid["hk"], "option": "Approved for production",
                                       "label": "Release approval", "signer_id": w.uid["hk"],
                                       "signer_name": PEOPLE["hk"][0], "signed_at": now - timedelta(hours=20),
                                       "via": "web", "removed": None, "history": []})
    await doc("rate-limits", "rohan", "API rate limits", f"""# API rate limits

The default limit is **100 requests per minute per API token**.

Export endpoints allow **300 requests per minute** since {fmt(D(1))} (raised from 100 after the 429 errors big workspaces hit).

A 429 response carries a Retry-After header.
""", created_ago=9, updated_ago=1)
    await doc("onboarding-guide", "priya", "Onboarding guide", """# Onboarding guide

1. Create a workspace.
2. Invite your team from Settings › Members.
3. Import your first meeting.

New users get onboarding email variant B (shorter subject line).
""", created_ago=15, updated_ago=0)
    await doc("meetings-privacy", "hk", "Meetings privacy", """# Meetings privacy

A meeting restricted to its attendees is readable only by them. Transcripts follow the meeting page's access.
Admins can delete a restricted meeting but cannot read it.
""", created_ago=3, updated_ago=1)
    await doc("slack-design", "hk", "Slack app design notes", """# Slack app design notes

The Slack app posts meeting summaries to a channel, answers /markdrop ask, and unfurls Markdrop links.
OAuth uses the workspace install flow; tokens are encrypted at rest.
""", created_ago=6, updated_ago=2)
    await doc("old-retro", "hk", "2025 planning retro", "# 2025 planning retro\n\nOld notes about 2025 planning.",
              created_ago=90, updated_ago=80)
    await doc("salary-bands", "sneha", "Salary bands 2027", """# Salary bands 2027 (confidential)

L5 band: 38 to 46 LPA. L6 band: 52 to 64 LPA.
""", state="P", created_ago=6, updated_ago=6)
    await doc("ask-docs", "hk", "Ask Markdrop docs draft", """# Ask Markdrop docs draft

Ask Markdrop answers from everything you can open. Press Cmd J to open it.
""", created_ago=2, updated_ago=0)
    # Their own files outside any workspace ("Ask my files").
    d = await w.mkdoc("UP", owner="hk", slug="hk-personal-todo", title="Personal todo", grants=False,
                      content="# Personal todo\n\n- [ ] Renew my passport by December 1\n- [ ] Call the bank about the home loan",
                      created_at=now - timedelta(days=3), updated_at=now - timedelta(days=1))
    await search_index.index_doc(w.db, d["_id"])
    ids["docs"]["hk-personal-todo"] = d
    # Version history: hk edited the roadmap yesterday and the rate limits doc two days ago.
    for key, ago in (("q4-roadmap", 1), ("rate-limits", 2)):
        d = ids["docs"][key]
        await w.db["document_versions"].insert_one({
            "doc_id": str(d["_id"]), "slug": d["slug"], "n": 1, "ts": now - timedelta(days=ago), "started_at": now - timedelta(days=ago),
            "author_id": w.uid["hk"], "author_kind": "user", "author_name": PEOPLE["hk"][0], "title": d["title"],
            "markdown": d["content"], "bytes": len(d["content"]), "sealed": True})
    if noise:
        for i, (key, title, body) in enumerate(NOISE_DOCS):
            await doc(key, ("aarav", "priya", "rohan", "sneha")[i % 4], title, body, created_ago=20 + i, updated_ago=15 + i)
    await seed_coverage(w, ids, imp)
    await search_index.drain()
    return ids


# ── Whole-length coverage (feat/ask-coverage): a long transcript, Office files, a captioned video ──

VENDOR_LINE = ("Aarav Mehta: Last thing on Zephyr: the data contract renews on March 3, and we agreed to cap it at "
               "forty thousand dollars a year.")
REFUND_RULE = "Refunds over 500 dollars need a second approver from finance, currently Rohan Gupta."
CHURN_NOTE = "Churn fell to 2.1 percent in October, down from 3.4 percent in July."
VIDEO_CUE = "The export button is hidden in the three-dot menu on the table header; click it and choose CSV."
OFFER_SECRET = "Joining bonus for the L5 offer: 3 lakh rupees, paid after 90 days."


async def seed_coverage(w, ids: dict, imp) -> None:
    """A 90-minute vendor review (the answer at minute 70), a Word spec, a PowerPoint deck, an Excel
    budget, a video with captions, and a private Word file of Sneha's. Seeded with the baseline's own
    means only (import, documents rows, R2 objects), so the same world runs on origin/main."""
    from tests.ask_eval import fixtures as F

    from app.services import search_index

    now = datetime.now(timezone.utc)
    vtt = F.long_vtt(90, at_min=70, line=VENDOR_LINE.split(": ", 1)[1])
    vtt = vtt.replace("<v Kabir Singh>", "<v Aarav Mehta>")
    got = await imp("Vendor review", D(3), vtt, False, name="Vendor review.vtt")
    ids["meetings"]["vendor"] = got

    async def file(key: str, owner: str, title: str, data: bytes, mime: str, filename: str, *, state: str = "W",
                   updated_ago: int = 2, **extra) -> dict:
        d = await w.mkdoc(state, owner=owner, ws="ACME", kind="artifact", slug=key, title=title, grants=False,
                          created_at=now - timedelta(days=updated_ago + 1), updated_at=now - timedelta(days=updated_ago))
        w.r2.put_bytes(d["blob_key"], data, mime, False)
        await w.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"mime": mime, "size_bytes": len(data),
                                                                          "original_filename": filename, **extra}})
        await search_index.index_doc(w.db, d["_id"])
        ids["docs"][key] = d
        return d

    await file("payments-spec", "rohan", "Payments API spec", F.make_docx([
        ("Title", "Payments API spec"), (None, "This spec covers charges, payouts and refunds."),
        ("Heading1", "Charges"), (None, "Charges are created with an idempotency key and settle in two days."),
        ("Heading1", "Refunds"), (None, REFUND_RULE), (None, "Partial refunds are allowed once per charge."),
        ("Heading1", "Webhooks"), (None, "Every event is signed with the workspace secret.")]),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "payments-spec.docx")
    await file("board-deck", "aarav", "Q4 board deck", F.make_pptx([
        ("Q4 board update", "Thank everyone for joining."), ("Revenue", "ARR grew 18 percent quarter on quarter."),
        ("Hiring", "Four engineers joined this quarter."), ("Retention", CHURN_NOTE),
        ("Next quarter", "Focus on the Slack app and enterprise SSO.")]),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", "q4-board.pptx")
    await file("infra-budget", "aarav", "Infra budget 2027", F.make_xlsx({
        "Summary": [["Area", "Annual USD"], ["Cloud", "64000"], ["Tools", "9000"]],
        "Cloud": [["Item", "Annual USD", "Owner"], ["Database cluster", "22000", "Rohan"],
                  ["GPU cluster", "18500", "Aarav"], ["Object storage", "6000", "Rohan"]]}),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "infra-budget-2027.xlsx")
    video = await file("walkthrough", "priya", "Onboarding walkthrough", b"\0" * 64, "video/mp4", "walkthrough.mp4")
    cues = [(5, "Welcome to Markdrop. This walkthrough shows a new workspace."),
            (95, "First, create a workspace and give it a name."), (250, "Invite your team from Settings, then Members."),
            (500, VIDEO_CUE), (640, "That's it. Questions go to the support channel.")]
    key = video["blob_key"].rsplit("/", 1)[0] + "/walkthroughcaps.captions.vtt"
    w.r2.put_bytes(key, F.vtt(cues).encode(), "text/vtt", False)
    await w.db["documents"].update_one({"_id": video["_id"]}, {"$set": {"captions_key": key,
                                                                        "captions_name": "walkthrough.vtt"}})
    await search_index.index_doc(w.db, video["_id"])
    await file("offer-template", "sneha", "Offer letter template", F.make_docx([
        ("Title", "Offer letter template"), (None, OFFER_SECRET)]),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "offer.docx", state="P")
    for _ in range(10):
        n = await search_index.extract_pending(w.db)
        around = getattr(search_index, "around_pending", None)
        if not n and not (around and await around(w.db)):
            break
