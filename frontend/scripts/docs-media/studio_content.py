"""Markdrop Guides demo content (seed_extra_studio.py): the pages of Acme's three guides and of the
synthetic GitBook import. All of it is invented for the demo world ("Acme", a dashboards product):
what a docs screenshot shows should read like a real team's docs, not lorem ipsum."""

import re

_BLOCK = re.compile(r"^(#|-|\*|\||`|:|>|!\[|\d+\.\s|\s*$)")


def unwrap(md: str) -> str:
    """Join a paragraph's wrapped lines (the editor shows each source line break as a line break)."""
    out: list[str] = []
    fence = False
    for line in md.split("\n"):
        if line.startswith("```"):
            fence = not fence
            out.append(line)
            continue
        if not fence and out and not _BLOCK.match(line) and out[-1] and not _BLOCK.match(out[-1]) \
                and not out[-1].startswith("```"):
            out[-1] = f"{out[-1]} {line}"
        else:
            out.append(line)
    return "\n".join(out)

# ── Acme Docs (product docs, Clean theme + Acme's brand) ─────────────────────────
# (path, title, description, icon, markdown). "/" and the template's pages are overwritten.

ACME_HOME = """Acme turns the data you already have into dashboards your whole team can read. Connect a
database, pick the numbers that matter, and share a link. Nobody needs to write SQL to read a dashboard.

## Where to start

::::cards
:::card[Quickstart]{href="/getting-started/quickstart" icon="zap"}
Create a project, connect data and share your first dashboard in about ten minutes.
:::
:::card[Key concepts]{href="/getting-started/key-concepts" icon="bulb"}
Projects, sources, dashboards and alerts, and how they fit together.
:::
:::card[Connect Postgres]{href="/guides/connect-postgres" icon="link"}
A read-only user and five minutes.
:::
:::card[The CLI]{href="/reference/cli" icon="code"}
Every command, with examples.
:::
::::

:::note
These docs describe Acme Cloud. A self-hosted Acme has the same features, with a few settings in a
config file instead of the web app.
:::
"""

INTRODUCTION = """Acme is a dashboards product for teams. It reads your databases and SaaS tools, keeps the
numbers fresh, and tells you when one moves.

## Who these docs are for

- **Analysts** who connect data sources and build dashboards.
- **Team leads** who share dashboards and set alert rules.
- **Developers** who automate Acme with the CLI and the API.

## What you can do with Acme

| You want to | Read |
| --- | --- |
| See this week's signups next to last week's | [Build a dashboard](/guides/build-a-dashboard) |
| Get a Slack message when revenue drops | [Alert rules](/guides/alert-rules) |
| Keep metrics in Git | [CLI reference](/reference/cli) |
"""

QUICKSTART = """This guide walks you through creating a project, connecting a data source and sharing your
[first dashboard](/guides/build-a-dashboard).

## Before you start

You need an Acme account and the address of a database Acme can reach. A read-only user is enough.

:::note
You need the Admin role to connect data sources. Ask a workspace owner if you don't have it.
:::

## Install the CLI

::::tabs{sync="os"}
:::tab[macOS]
```bash
brew install acme/tap/acme
```
:::
:::tab[Linux]
```bash
curl -fsSL https://get.acme.example/install.sh | sh
```
:::
:::tab[Windows]
```powershell
winget install Acme.CLI
```
:::
::::

## Create a project

::::steps
### Sign in
The CLI opens your browser once and stores a token for later.

```bash
acme login
```

### Create the project
Projects group your sources, dashboards and alerts. Name it after the team that will use it.

```bash
acme projects create "Growth"
```

### Connect a source
Point Acme at your database. See [Connect Postgres](/guides/connect-postgres) for the details.
::::

## Share it

Every dashboard has a link. Anyone in your workspace can open it; people outside need an invite.

:::tip
Pin the dashboard to your team's channel: the preview updates every time the numbers change.
:::
"""

KEY_CONCEPTS = """Four things make up everything in Acme.

| Concept | What it is |
| --- | --- |
| **Project** | A team's space: its sources, dashboards and alerts. |
| **Source** | A database or tool Acme reads, every 5 minutes. |
| **Dashboard** | Charts on one page, with a link you can share. |
| **Alert rule** | A number Acme watches, and who to tell when it moves. |

## How they fit together

A source feeds metrics. A dashboard shows metrics. An alert rule watches one metric on a schedule.
Delete a source and its dashboards keep their last numbers until you connect a new one.
"""

CONNECT_POSTGRES = """Acme only reads. Give it a user that can do nothing else.

## Create a read-only user

```sql title="Run as a database owner"
CREATE ROLE acme_reader WITH LOGIN PASSWORD 'choose-a-long-one';
GRANT CONNECT ON DATABASE app TO acme_reader;
GRANT USAGE ON SCHEMA public TO acme_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acme_reader;
```

## Add the source

```bash
acme sources add postgres \\
  --project growth \\
  --host db.internal.example \\
  --user acme_reader
```

The CLI asks for the password and never echoes it.

:::warning[Network access]
Acme connects from fixed addresses. Allow them in your firewall before you add the source, or the
first check fails with a timeout.
:::

## Check the connection

```bash
acme sources test postgres --project growth
```

A good connection lists the tables Acme can read.
"""

BUILD_A_DASHBOARD = """A dashboard is a page of charts with one link.

## Add a chart

::::steps
### Open the project
Choose **Dashboards**, then **New dashboard**.

### Pick a metric
Search for a metric, like `signups`, and choose how to show it: a number, a line or a table.

### Compare
Turn on **Compare with** and pick *last week* to see the change beside each number.
::::

## Share the link

Choose **Share**. People in your workspace can open the link straight away.
"""

ALERT_RULES = """An alert rule watches one number on a schedule and notifies you when it crosses a line.

## Create a rule

```bash
acme alerts create \\
  --project growth \\
  --chart signups \\
  --when "below 100 for 2 checks" \\
  --notify "#growth"
```

## Choose a threshold

- **Fixed**: below 100, above 5,000.
- **Relative**: 20 % lower than the same day last week.
- **Missing**: no new rows for an hour.

:::note
Rules check every 5 minutes. "For 2 checks" means the number has to stay over the line for 10
minutes before anyone is notified, which stops one bad reading from waking people up.
:::

## Mute a rule

Muting keeps the rule and its history; it just stops notifications until the time you choose.
"""

INVITE_YOUR_TEAM = """Everyone who reads a dashboard needs a seat in the workspace.

1. Open **Settings › People** and choose **Invite**.
2. Type their work email and pick a role: **Viewer**, **Editor** or **Admin**.
3. They get an email with a link that works for 7 days.

:::tip
Invite a whole team at once: paste a list of addresses separated by commas.
:::
"""

CLI_REFERENCE = """The CLI talks to the same API as the web app. Every command takes `--project` and `--json`.

## acme login

Signs in through your browser and stores a token in your system keychain.

```bash
acme login
```

## acme projects

```bash
acme projects list
acme projects create "Growth"
```

## acme sources

```bash
acme sources add postgres --project growth --host db.internal.example --user acme_reader
acme sources test postgres --project growth
```

## acme alerts

```bash
acme alerts list --project growth
acme alerts mute signups-low --for 2h
```

| Flag | What it does |
| --- | --- |
| `--project` | The project to act on |
| `--json` | Print machine-readable output |
| `--quiet` | Print nothing but errors |
"""

API_KEYS = """API keys let scripts and CI talk to Acme without a browser.

## Create a key

Open **Settings › API keys** and choose **New key**. Copy it straight away: Acme shows it once.

```bash
export ACME_API_KEY=acme_live_…
acme projects list
```

:::danger[Treat keys like passwords]
A key can read every dashboard in the workspace. Store it in your CI's secret store, never in a
repository. Revoke a key you no longer need.
:::
"""

FAQ = """## Can people outside my company see a dashboard?

Only if you invite them. Dashboards are private to your workspace by default.

## How fresh are the numbers?

Sources sync every 5 minutes. A chart shows when its data was last updated.

## Does Acme copy my database?

No. Acme keeps the aggregated numbers it shows, not your rows.

:::details[What about personal data?]
Acme never stores columns you mark as personal. Mark them under **Source › Columns**.
:::
"""

RELEASE_NOTES = """## 2.4 · October

- **Workflows (beta)**: run a Slack message, a webhook or an email when an alert fires.
- Compare any chart with the same period last year.
- The CLI's `acme alerts mute` takes `--until` as well as `--for`.

## 2.3 · September

- Dashboards load twice as fast with more than 20 charts.
- Postgres sources can read from a replica.
"""

LEGACY_CONNECTORS = """These connectors still work but no longer get new features. Move to the new ones when
you can.

| Old connector | Replaced by |
| --- | --- |
| MySQL 5.7 | MySQL 8 |
| Google Sheets (v1) | Google Sheets |
"""

ACME_DOCS_PAGES = {
    "/": ("Acme documentation", "Guides and reference for Acme, the dashboards your whole team can read.", "home", ACME_HOME),
    "/getting-started/introduction": ("What is Acme?", "What Acme does, who it is for, and where to start reading.", "book", INTRODUCTION),
    "/getting-started/quickstart": ("Quickstart", "Set up your first project and invite your team in about ten minutes.", "zap", QUICKSTART),
    "/getting-started/key-concepts": ("Key concepts", "Projects, sources, dashboards and alerts, and how they fit together.", "bulb", KEY_CONCEPTS),
    "/guides/connect-postgres": ("Connect Postgres", "Give Acme a read-only user and connect it in five minutes.", "link", CONNECT_POSTGRES),
    "/guides/build-a-dashboard": ("Build a dashboard", "Charts on one page, with a link you can share.", "chart", BUILD_A_DASHBOARD),
    "/guides/alert-rules": ("Alert rules", "Get pinged when a metric moves, and only then.", "flag", ALERT_RULES),
    "/guides/invite-your-team": ("Invite your team", "Give people a seat and the right role.", "users", INVITE_YOUR_TEAM),
    "/reference/cli": ("CLI reference", "Every acme command, its flags and an example of each.", "terminal", CLI_REFERENCE),
    "/reference/api-keys": ("API keys", "Create, store and revoke keys for scripts and CI.", "key", API_KEYS),
    "/help/faq": ("FAQ", "Short answers to what people ask most.", "message", FAQ),
    "/help/release-notes": ("Release notes", "What changed in each version of Acme.", "sparkle", RELEASE_NOTES),
    "/guides/legacy-connectors": ("Legacy connectors", "Connectors that still work but no longer get new features.", "layers", LEGACY_CONNECTORS),
}
ACME_DOCS_NAV = [
    ("Getting started", ["/", "/getting-started/introduction", "/getting-started/quickstart", "/getting-started/key-concepts"]),
    ("Guides", ["/guides/connect-postgres", "/guides/build-a-dashboard", "/guides/alert-rules", "/guides/invite-your-team"]),
    ("Reference", ["/reference/cli", "/reference/api-keys"]),
    ("Help", ["/help/faq", "/help/release-notes"]),
]
ACME_DOCS_HIDDEN = ["/guides/legacy-connectors"]

# Later edits (Alex's work in progress, unpublished): the changes list on Publish.
QUICKSTART_V2 = QUICKSTART.replace(
    "## Share it\n",
    "## Invite your team\n\nAdd the people who will read the dashboard before you share it: see "
    "[Invite your team](/guides/invite-your-team).\n\n## Share it\n",
)
ALERT_RULES_V2 = ALERT_RULES.replace(
    "## Mute a rule\n",
    "## Send it somewhere else\n\nBesides Slack, a rule can email a list or call a webhook. Add `--notify` once "
    "per destination.\n\n## Mute a rule\n",
)
WORKFLOWS = """Workflows run when an alert fires: post to Slack, call a webhook, or email a list.

:::note[Beta]
Workflows are in beta on every plan. Tell us what you build with them.
:::

## Create a workflow

::::steps
### Pick the trigger
Open an alert rule and choose **Add workflow**.

### Add steps
Each step runs after the one before it. A failed step stops the workflow and is retried 3 times.

### Turn it on
Workflows start switched off, so you can test them with **Run now** first.
::::
"""

# ── Acme Help Center (Help center theme, reviews required) ──────────────────────

HELP_HOME = """Answers to the questions people ask our support team most. Can't find yours? Write to
support@acme.example.
"""
CHANGE_EMAIL = """1. Open **Settings › Profile**.
2. Choose **Change** next to your email address.
3. Confirm the new address from the email we send you.

Your old address keeps working until you confirm the new one.
"""
INVOICES = """Workspace owners and billing admins can download every invoice.

1. Open **Settings › Billing**.
2. Under **Invoices**, choose **Download** next to the month you need.

Invoices are PDFs with your company's name and tax number, if you added them.
"""
CANT_SIGN_IN = """Try these in order:

- **Check the address.** Your workspace might use single sign-on: open `acme.example/sso`.
- **Reset your password** from the sign-in page. The link works for one hour.
- **Two-factor codes rejected?** Check your phone's clock is set automatically.

Still stuck? Write to support with the email address you sign in with.
"""
REFUNDS = """You can ask for a refund within 30 days of a payment.

## Monthly plans

We refund the last payment in full when you cancel within 30 days of it.

## Annual plans

We refund the unused months when you cancel in the first 60 days.
"""
REFUNDS_V2 = REFUNDS.replace(
    "## Annual plans\n\nWe refund the unused months when you cancel in the first 60 days.\n",
    "## Annual plans\n\nWe refund the unused months when you cancel in the first 90 days. After that, the plan runs to "
    "the end of the year and doesn't renew.\n\n:::note\nRefunds go back to the card you paid with, in 5 to 10 working days.\n:::\n",
)
CHANGE_PLAN = """Owners change the plan in **Settings › Billing › Plan**. A bigger plan starts at once and you
pay the difference for the rest of the period. A smaller plan starts at the next renewal.
"""
TWO_FACTOR = """Turn on two-factor sign-in in **Settings › Security**. Scan the QR code with an
authenticator app and type the six-digit code to confirm. Keep the backup codes somewhere safe.
"""
DASHBOARD_SLOW = """A dashboard with many charts loads each chart on its own. If one stays empty:

- Open the chart's menu and choose **Refresh**.
- Check the source under **Data sources**: a red dot means its last sync failed.
"""
TWO_FACTOR_V2 = TWO_FACTOR + "\nLost your phone? Use a backup code to sign in, then set up two-factor sign-in again.\n"

HELP_PAGES = {
    "/": ("Acme Help Center", "Answers to the questions people ask our support team most.", "home", HELP_HOME),
    "/account/change-email": ("Change your email address", "Move your account to a new email address.", "mail", CHANGE_EMAIL),
    "/account/two-factor": ("Turn on two-factor sign-in", "Protect your account with a code from your phone.", "shield", TWO_FACTOR),
    "/billing/invoices": ("Download an invoice", "Every invoice is a PDF in Settings › Billing.", "doc", INVOICES),
    "/billing/refunds": ("Refunds", "When we refund a payment, and how much.", "rotate", REFUNDS),
    "/billing/change-plan": ("Change your plan", "Move to a bigger or smaller plan.", "layers", CHANGE_PLAN),
    "/troubleshooting/cant-sign-in": ("I can't sign in", "What to check when sign-in fails.", "lock", CANT_SIGN_IN),
    "/troubleshooting/dashboard-not-loading": ("A dashboard isn't loading", "What to do when charts stay empty.", "chart", DASHBOARD_SLOW),
}
HELP_NAV = [
    ("Account", ["/", "/account/change-email", "/account/two-factor"]),
    ("Billing", ["/billing/invoices", "/billing/refunds", "/billing/change-plan"]),
    ("Troubleshooting", ["/troubleshooting/cant-sign-in", "/troubleshooting/dashboard-not-loading"]),
]

# ── A synthetic GitBook import (Acme Developer Docs) ───────────────────────────
# What the importer would hand back (docs-platform/runner → services/docs_import_job.apply_import).

def dev_import(brand_name: str = "Acme") -> dict:
    b = brand_name
    low = b.lower()
    pages = [
        ("/", f"{b} developer docs", f"Build on {b}: the REST API, webhooks and SDKs.", "code",
         f"Everything you need to read and write {b} data from your own code.\n\n::::cards\n"
         ":::card[Authentication]{href=\"/getting-started/authentication\" icon=\"key\"}\nKeys, scopes and how to send them.\n:::\n"
         ":::card[Query metrics]{href=\"/api/metrics/query\" icon=\"chart\"}\nThe endpoint most integrations start with.\n:::\n"
         ":::card[Webhooks]{href=\"/webhooks/overview\" icon=\"zap\"}\nGet told when an alert fires.\n:::\n::::\n"),
        ("/getting-started/authentication", "Authentication", "Send an API key with every request.", "key",
         f"Every request needs an API key in the `Authorization` header.\n\n```bash\ncurl https://api.{low}.example/v2/projects \\\n"
         f"  -H \"Authorization: Bearer ${b.upper()}_API_KEY\"\n```\n\n![Where to create a key in Settings](/docs-assets/import/getting-started/authentication/api-keys.png)\n\n"
         ":::warning\nKeys are secrets. Never put one in client-side code.\n:::\n"),
        ("/getting-started/rate-limits", "Rate limits", "How many requests you can make, and what happens after.", "clock",
         "The API allows 600 requests a minute per key. Over the limit you get `429 Too Many Requests` with a "
         "`Retry-After` header.\n\n| Header | Meaning |\n| --- | --- |\n| `X-RateLimit-Remaining` | Requests left this minute |\n"
         "| `Retry-After` | Seconds to wait |\n"),
        ("/api/metrics/query", "Query metrics", "Read a metric's values over a time range.", "chart",
         "`POST /v2/metrics/query`\n\n```json title=\"Request\"\n{\n  \"metric\": \"signups\",\n  \"from\": \"2026-10-01\",\n  \"to\": \"2026-10-31\",\n  \"interval\": \"day\"\n}\n```\n\n"
         "::::tabs{sync=\"lang\"}\n:::tab[curl]\n```bash\ncurl -X POST https://api." + low + ".example/v2/metrics/query -d @query.json\n```\n:::\n"
         ":::tab[Python]\n```python\nclient.metrics.query(metric=\"signups\", interval=\"day\")\n```\n:::\n::::\n"),
        ("/api/metrics/ingest", "Send events", "Push your own events into a metric.", "upload",
         "`POST /v2/events` takes up to 500 events per call.\n\n![The events pipeline](/docs-assets/import/api/metrics/ingest/pipeline.png)\n"),
        ("/api/dashboards/list", "List dashboards", "Every dashboard in a project.", "layers",
         "`GET /v2/projects/{project}/dashboards` returns the dashboards, newest first, 50 per page.\n\n"
         "See the [old pagination guide](/guides/pagination-v1) if you still use cursors from v1.\n"),
        ("/webhooks/overview", "Webhooks", "Get a POST when an alert fires.", "zap",
         "Add an endpoint under **Settings › Webhooks**. We send a JSON body and retry 5 times over an hour.\n\n"
         "![A webhook delivery in the log](/docs-assets/import/webhooks/overview/delivery-log.png)\n"),
        ("/webhooks/signatures", "Verify signatures", "Check that a webhook really came from us.", "shield",
         "Every delivery has an `X-Signature` header: an HMAC-SHA256 of the body with your endpoint's secret.\n\n"
         "```python\nimport hmac, hashlib\nexpected = hmac.new(secret, body, hashlib.sha256).hexdigest()\n```\n"),
        ("/sdks/python", "Python SDK", "pip install and three lines of code.", "terminal",
         f"```bash\npip install {low}\n```\n\n```python\nfrom {low} import Client\nclient = Client()\nprint(client.projects.list())\n```\n"),
        ("/sdks/node", "Node SDK", "npm install and an async client.", "code",
         f"```bash\nnpm install @{low}/sdk\n```\n\nSee the [examples repository](https://github.com/{low}-example/sdk-examples/tree/main/node-old) for more.\n"),
        ("/legacy/v1-api", "API v1 (deprecated)", "The old API, for integrations that haven't moved yet.", "flag",
         "v1 stops answering on 30 June 2027. Move to v2 before then.\n"),
    ]
    nav = [
        {"group": "Getting started", "pages": ["/getting-started/authentication", "/getting-started/rate-limits"]},
        {"group": "API reference", "pages": ["/api/metrics/query", "/api/metrics/ingest", "/api/dashboards/list"]},
        {"group": "Webhooks", "pages": ["/webhooks/overview", "/webhooks/signatures"]},
        {"group": "SDKs", "pages": ["/sdks/python", "/sdks/node"]},
    ]
    report = {
        "format": "markdrop-docs-import/1",
        "source": f"https://{low}.gitbook.io/developers",
        "counts": {"pages": len(pages), "failed": 0, "inNav": len(pages) - 1, "hidden": 1, "groups": len(nav), "tabs": 0,
                   "images": 9, "files": 1, "gifsConverted": 0, "gifsKept": True, "notes": 2, "brokenLinks": 2, "missing": 1,
                   "altGenerated": 3, "unmatchedIcons": 2, "headingIdsChanged": 4, "redirects": 14},
        "items": {
            "altGenerated": [
                {"page": "/getting-started/authentication", "line": 9, "alt": "api keys"},
                {"page": "/api/metrics/ingest", "line": 3, "alt": "pipeline"},
                {"page": "/webhooks/overview", "line": 3, "alt": "delivery log"},
            ],
            "hidden": [{"page": "/legacy/v1-api", "title": "API v1 (deprecated)"}],
            "brokenLinks": [
                {"page": "/api/dashboards/list", "line": 3, "href": "/guides/pagination-v1", "reason": "no such page on the GitBook site"},
                {"page": "/sdks/node", "line": 5, "href": f"https://github.com/{low}-example/sdk-examples/tree/main/node-old", "reason": "404 on the old site"},
            ],
            "missing": [{"page": "/sdks/python", "line": 0, "src": f"https://{low}.gitbook.io/~gitbook/image?url=autocomplete-old.gif", "reason": "download failed: kept the original URL"}],
            "unmatchedIcons": [{"icon": "python", "pages": ["/sdks/python"]}, {"icon": "node-js", "pages": ["/sdks/node"]}],
            "notes": [
                {"page": "/api/metrics/query", "line": 12, "kind": "block", "message": "GitBook “swagger” block converted to a code sample"},
                {"page": "/", "line": 1, "kind": "nav", "message": "Top-level page README has no group in GitBook; it opens the “Getting started” group."},
            ],
            "external": [{"title": "Status page", "href": f"https://status.{low}.example"}],
        },
    }
    redirects = {"/readme": "/", "/getting-started/auth": "/getting-started/authentication"}
    return {
        "pages": [{"path": p, "title": t, "description": d, "icon": i, "markdown": unwrap(m), "hidden": p.startswith("/legacy/")}
                  for p, t, d, i, m in pages],
        "nav": nav,
        "site": {"brand": {"accent": "#0F766E" if b == "Acme" else "#B45309"}},
        "redirects": redirects,
        "assets": {"files": 10, "bytes": 1840213},
        "report": report,
    }
