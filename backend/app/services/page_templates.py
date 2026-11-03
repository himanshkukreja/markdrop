"""The built-in page templates (``GET /api/v1/page-templates``, MCP
``list_page_templates``, ``POST /api/v1/pages {template}``).

Each is Markdown in the block editor's syntax (callouts ``:::note``, toggles
``:::details{summary="…"}``, checklists, tables, code, quotes, dividers), so it
round-trips through the editor unchanged. ``{{date}}`` and ``{{title}}`` are
filled in when a page is made from one. The page's title is its own field, so
a template's body doesn't repeat it as a heading.
"""

from __future__ import annotations

from datetime import datetime, timezone

_FEATURE_GUIDE = """:::note
**Release:** {{date}} · **Status:** Draft · **Owner:** _you_
:::

## What's new

One or two sentences on what changed and who it's for.

## Why it matters

- The problem it solves
- Who asked for it
- What people can do now that they couldn't before

## How to use it

1. Open **Settings › …**
2. Turn on **…**
3. Try it with a small example first.

:::tip
Link a short video or a screenshot here: people read the first picture before the first paragraph.
:::

## What changed

| Area | Before | After |
| --- | --- | --- |
| Example | Old behaviour | New behaviour |

## Known limits

:::warning
List anything that doesn't work yet, so nobody finds out the hard way.
:::

## Rollout

- [ ] Docs updated
- [ ] Support briefed
- [ ] Announcement sent

---

:::details{summary="Changelog entry"}
**{{title}}** — one line for the changelog.
:::
"""

_CUSTOMER_HOWTO = """Last updated {{date}}.

## Before you start

You need:

- An account with access to **…**
- About 5 minutes

## Steps

1. Go to **…**
2. Choose **…**
3. Click **Save**.

:::tip
Paste a screenshot after each step: readers follow pictures faster than words.
:::

## Check it worked

You should see **…**. If you don't, see the questions below.

## Common questions

:::details{summary="I don't see the option"}
Explain the most likely reason and how to fix it.
:::

:::details{summary="Can I undo it?"}
Explain how to undo it, or say plainly that it can't be undone.
:::

---

Still stuck? Contact support and mention **{{title}}**.
"""

_QA_TEST_PLAN = """:::note
**Build:** … · **Tester:** … · **Date:** {{date}}
:::

## Scope

What's being tested, and what isn't.

## Environments

| Environment | Version | Notes |
| --- | --- | --- |
| Staging | … | |
| Mobile (iOS / Android) | … | |

## Test cases

| # | Case | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Happy path | … | … | ⬜ |
| 2 | Empty state | … | … | ⬜ |
| 3 | Error handling | … | … | ⬜ |

## Checklist

- [ ] Light and dark themes
- [ ] Small screens (390 px)
- [ ] Keyboard only
- [ ] Screen reader labels
- [ ] Slow network

## Bugs found

:::warning
Link each bug with its severity. Blockers go first.
:::

## Sign-off

- [ ] QA
- [ ] Product
- [ ] Engineering
"""

_PRD = """:::note
**Author:** … · **Status:** Draft · **Last updated:** {{date}}
:::

## Problem

Who has the problem, how often, and what it costs them today.

## Goals

- …

## Non-goals

- …

## Users and use cases

> "Quote a real user if you have one."

## Proposal

Describe the solution at the level a designer and an engineer can both start from.

:::tip
A rough sketch or a screenshot beats a paragraph here.
:::

## Requirements

| Priority | Requirement | Notes |
| --- | --- | --- |
| Must | … | |
| Should | … | |
| Could | … | |

## Success metrics

- …

## Risks and open questions

:::warning
What could make this fail, and what we still need to decide.
:::

:::details{summary="Alternatives considered"}
What else was considered, and why not.
:::

## Launch checklist

- [ ] Design review
- [ ] Engineering review
- [ ] Docs and support
- [ ] Announcement
"""

_MEETING_NOTES = """**Date:** {{date}} · **Attendees:** …

## Agenda

1. …
2. …

## Notes

- …

## Decisions

:::note
Write each decision as one sentence someone who missed the meeting can act on.
:::

## Action items

- [ ] … (owner, due date)
- [ ] … (owner, due date)

---

:::details{summary="Parking lot"}
Topics to pick up next time.
:::
"""

_RUNBOOK = """:::danger
**When to use this:** describe the alert or symptom. **Owner:** … · **Last reviewed:** {{date}}
:::

## Impact

Who is affected and how badly.

## Check first

```bash
# Paste the first command an on-call engineer should run
```

## Steps to mitigate

1. …
2. …
3. …

:::warning
Anything that must never be done during an incident (and why).
:::

## Verify

- [ ] Error rate back to normal
- [ ] Alert resolved
- [ ] Customers notified, if needed

## Escalation

| Who | When | How |
| --- | --- | --- |
| Primary on-call | Immediately | … |
| Team lead | After 30 minutes | … |

:::details{summary="Background: how the system works"}
A short explanation of the moving parts, for someone seeing this for the first time.
:::

## After the incident

- [ ] Write the post-mortem
- [ ] Update this runbook
"""

TEMPLATES: list[dict] = [
    {"id": "feature-guide", "name": "Feature guide / release notes", "category": "Product",
     "icon": "sparkles", "description": "Announce a feature: what's new, why it matters, how to use it, rollout.",
     "content": _FEATURE_GUIDE},
    {"id": "customer-howto", "name": "Customer-facing how-to", "category": "Support",
     "icon": "life-buoy", "description": "Step-by-step instructions with checks and common questions.",
     "content": _CUSTOMER_HOWTO},
    {"id": "qa-test-plan", "name": "QA test plan", "category": "Engineering",
     "icon": "check-square", "description": "Scope, environments, test cases, checklist and sign-off.",
     "content": _QA_TEST_PLAN},
    {"id": "prd", "name": "Product spec", "category": "Product",
     "icon": "file-text", "description": "Problem, goals, proposal, requirements, metrics and risks.",
     "content": _PRD},
    {"id": "meeting-notes", "name": "Meeting notes", "category": "Team",
     "icon": "users", "description": "Agenda, notes, decisions and action items.",
     "content": _MEETING_NOTES},
    {"id": "runbook", "name": "Runbook", "category": "Engineering",
     "icon": "terminal", "description": "What to do when an alert fires: checks, steps, escalation.",
     "content": _RUNBOOK},
    {"id": "blank", "name": "Blank page", "category": "Basic",
     "icon": "file", "description": "Start from an empty page.",
     "content": ""},
]

BY_ID = {t["id"]: t for t in TEMPLATES}


def all_templates() -> list[dict]:
    return [dict(t) for t in TEMPLATES]


def get(template_id: str | None) -> dict | None:
    t = BY_ID.get((template_id or "").strip())
    return dict(t) if t else None


def fill(content: str, *, title: str, now: datetime | None = None) -> str:
    d = now or datetime.now(timezone.utc)
    when = f"{d:%B} {d.day}, {d:%Y}"
    return content.replace("{{date}}", when).replace("{{title}}", title)
