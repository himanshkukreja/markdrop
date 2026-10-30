"""The demo world's documents (seed.py). Realistic content for the Acme workspace and Riya's own
files: what a docs screenshot shows should read like a real team's work, not lorem ipsum."""

GETTING_STARTED = r"""# Getting started with Acme

Acme Cloud turns the data you already have — Postgres, Stripe, HubSpot, spreadsheets — into live dashboards and alerts your whole team can use. This guide takes you from an empty workspace to your first shared dashboard in about fifteen minutes.

## Before you begin

You need:

- An Acme workspace (sign up at `acme.com/start`; the Starter plan is free for up to three people)
- Read access to at least one data source
- The Acme CLI if you want to manage metrics as code (optional)

## Install the CLI

The CLI is a single binary. On macOS and Linux:

```bash
curl -fsSL https://get.acme.com/cli | sh
acme login
acme workspaces list
```

On Windows, use the installer from the downloads page, then run `acme login` from PowerShell.

## Connect a data source

Open **Data sources** and choose **Connect** next to the source you want. For Postgres, Acme needs a read-only user:

```sql
CREATE ROLE acme_reader WITH LOGIN PASSWORD '••••••••';
GRANT CONNECT ON DATABASE app TO acme_reader;
GRANT USAGE ON SCHEMA public TO acme_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acme_reader;
```

Acme syncs every five minutes. The first sync of a large table can take longer; the source shows **Syncing** until it finishes.

## How it fits together

```mermaid
flowchart LR
  A[Postgres] --> I[Ingest]
  B[Stripe] --> I
  C[HubSpot] --> I
  I --> S[(Columnar store)]
  S --> M[Metrics API]
  M --> D[Dashboards]
  M --> L[Alerts]
```

## Define your first metric

Metrics live in YAML so they can be reviewed like code:

```yaml
metric: weekly_active_teams
source: postgres.events
measure: count_distinct(team_id)
filters:
  - event_name in ('dashboard_viewed', 'alert_created')
grain: week
```

Push it with `acme metrics push`. It appears under **Metrics** within a minute.

Week-over-week growth is computed the same way everywhere, $g = \frac{x_t - x_{t-1}}{x_{t-1}}$, and the smoothed trend line uses an exponential moving average:

$$
\text{EMA}_t = \alpha \, x_t + (1 - \alpha)\, \text{EMA}_{t-1}, \qquad \alpha = \frac{2}{N + 1}
$$

## Build a dashboard

1. Choose **New dashboard** and give it a name, like *Revenue overview*.
2. Add a **Number** tile for MRR and a **Line** tile for weekly active teams.
3. Choose **Share** and add your team. Viewers can filter but can't change tiles.

| Tile | Best for | Refresh |
| --- | --- | --- |
| Number | One headline figure | Every sync |
| Line | Trends over time | Every sync |
| Table | Drill-down lists | On open |
| Funnel | Conversion steps | Hourly |

## Next steps

- Set up [alert rules](alert-rules) so you hear about changes before your customers do
- Read the [Postgres connection guide](connect-postgres) for SSL and SSH tunnels
- Join the weekly office hours, Thursdays at 16:00 UTC
"""

CONNECT_POSTGRES = r"""# Connecting Postgres

Acme reads from Postgres over a read-only connection. Nothing is ever written to your database.

## Requirements

- PostgreSQL 12 or later
- A user with `SELECT` on the tables you want to analyse
- Network access from Acme's addresses, or an SSH tunnel

## Allow Acme's addresses

| Region | Addresses |
| --- | --- |
| US East | `34.201.18.0/24` |
| EU (Frankfurt) | `18.153.40.0/24` |
| Asia Pacific | `13.250.92.0/24` |

## Use SSL

Acme always asks for TLS. To verify your server's certificate, paste its CA bundle under **Advanced → Server CA**. With `sslmode=verify-full` the hostname must match the certificate.

```text
postgres://acme_reader@db.internal.example:5432/app?sslmode=verify-full
```

## Connect through an SSH tunnel

If the database isn't reachable from the internet, give Acme a bastion host:

```bash
# On the bastion, allow Acme's public key
echo "ssh-ed25519 AAAAC3Nza…acme-tunnel" >> ~/.ssh/authorized_keys
```

Then fill in **SSH host**, **SSH user** and **SSH port** on the connection form.

## Troubleshooting

**Connection timed out.** Check the security group or firewall allows the addresses above on port 5432.

**permission denied for table.** Run the `GRANT SELECT` again after creating new tables, or set default privileges:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO acme_reader;
```
"""

ALERT_RULES = r"""# Alert rules reference

An alert rule watches one metric and notifies a channel when a condition holds.

## Conditions

| Condition | Example | Fires when |
| --- | --- | --- |
| `above` | `churn above 2%` | the value is greater than the threshold |
| `below` | `signups below 150` | the value is less than the threshold |
| `changes_by` | `mrr changes_by 10%` | the change since the previous period exceeds it |
| `missing` | `stripe missing 2h` | no new data arrives for the duration |

## Channels

- **Slack** — pick a channel; Acme posts a message with a chart and a link
- **Email** — up to 20 addresses per rule
- **PagerDuty** — uses your integration key; resolves automatically when the condition clears
- **Webhook** — a JSON `POST` with the rule, the value and the time

## Example

```yaml
alert: churn_spike
metric: weekly_churn_rate
condition: above 2%
for: 1 week
notify:
  - slack: "#revenue"
  - email: finance@acme.com
```

## Quiet hours

Rules can skip nights and weekends. Alerts that fire during quiet hours are delivered when they end, grouped into one message.
"""

RELEASE_24 = r"""# Release notes — v2.4

*Released October 28, 2026*

## Highlights

- **Workflows (beta).** Trigger actions from any metric: post to Slack, open a Jira ticket, or call a webhook when a condition holds. Ask your account team to join the beta.
- **Faster dashboards.** Median load time is down from 4.4 s to 1.9 s after moving tile queries to the columnar store.
- **Dark mode** for dashboards and the mobile app.

## Improvements

- Tables can now be exported to CSV with the current filters applied
- The Postgres connector supports `sslmode=verify-full` and custom CA bundles
- Alert messages in Slack include a sparkline of the last 14 days
- Dashboard filters remember your last selection per dashboard

## Fixes

- Fixed a time-zone bug that shifted weekly metrics by one day for teams in UTC+10 and beyond
- Funnels no longer double-count users who repeat a step
- The HubSpot connector retries on rate limits instead of failing the sync

## Deprecations

The v1 metrics API will be turned off on **January 31, 2027**. Move to `/v2/metrics`; the [migration guide](getting-started) covers the differences.
"""

RELEASE_23 = r"""# Release notes — v2.3

*Released September 30, 2026*

## Highlights

- **Shared dashboards on your own domain.** Publish read-only dashboards at an address like `metrics.yourcompany.com`.
- **Snowflake connector** (general availability).

## Improvements

- Number tiles show the change against the previous period
- New **Funnel** tile with up to eight steps
- SCIM provisioning for Okta and Azure AD on Business plans

## Fixes

- Fixed duplicate alert notifications after a sync retry
- Long dashboard names no longer overflow the sidebar
"""

SECURITY_FAQ = r"""# Enterprise security FAQ

Answers to the questions security teams ask us most. For our SOC 2 Type II report, ask your account manager.

## Where is our data stored?

In the region you pick when you create the workspace: US East (Virginia), EU (Frankfurt, from Q1 2027) or Asia Pacific (Singapore). Data never leaves that region.

## Do you store copies of our database?

Acme stores the columns your metrics use, aggregated where possible, in an encrypted columnar store. Raw rows are kept for 30 days to allow backfills, then deleted.

## How is data encrypted?

- In transit: TLS 1.2 or later everywhere
- At rest: AES-256, with keys in a cloud KMS and rotated yearly
- Backups: encrypted with separate keys, kept for 35 days

## Can we use our own identity provider?

Yes. SAML 2.0 SSO is available on Team and above; SCIM provisioning on Business and Enterprise.

## Who at Acme can see our data?

Only on-call engineers, through a just-in-time access request that you can require approval for. Every access is logged and visible in your audit log.
"""

MEETING_OCT_28 = r"""# Product sync — October 28

**Attendees:** Riya Sharma, Alex Chen, Sam Lee, Maya Okafor
**Notes:** Riya

## Agenda

1. Workflows beta: readiness
2. Dashboard performance follow-ups
3. Q4 product review deck

## Workflows beta

- 34 of 40 design partners have accepted the invite
- Slack and webhook actions are done; Jira is behind by a week
- Alex: rate limits on the action runner still need a load test before January

> Decision: ship the beta on **January 12** with Slack and webhooks. Jira follows in the first beta update.

## Dashboard performance

The columnar store migration brought the median load to 1.9 s. The slowest 5% are dashboards with more than 30 tiles.

- Maya to add tile-level caching for dashboards over 20 tiles
- Sam to design a "loading" state for slow tiles

## Q4 product review

Riya shared the draft deck. Feedback:

- Lead with the retention numbers, not MRR
- Add a slide on the EU residency risk
- Keep pricing to one slide

## Action items

- [x] Riya: share the Q4 deck draft
- [ ] Alex: load-test the action runner (due Nov 3)
- [ ] Maya: tile-level caching proposal (due Nov 5)
- [ ] Sam: slow-tile loading state mockups (due Nov 4)
"""

LAUNCH_NOTES = r"""# Launch notes: Workflows beta

Owner: Riya Sharma · Target: January 12, 2027

## Product

- [x] Slack action
- [x] Webhook action
- [ ] Jira action (first beta update)
- [ ] Usage limits enforced per plan

## Docs and enablement

- [x] Concept guide: what a workflow is
- [ ] Five starter templates
- [ ] 3-minute product video
- [ ] Support macros for the top ten questions

## Go-to-market

- [ ] Beta invite email to 40 design partners
- [ ] In-app announcement for admins
- [ ] Webinar on February 4

## Risks

| Risk | Owner | Mitigation |
| --- | --- | --- |
| Runner overload at peak | Alex | Load test + per-workspace limits |
| Confusing pricing | Riya | One-page FAQ before GA |
"""

INTERVIEW_NOTES = r"""# Interview loop — Senior data engineer

Candidate: J. Moreno · Loop on October 24

## Summary

Strong on streaming systems and pragmatic about cost. Recommend **hire**, pending references.

## System design (Alex)

Designed ingestion for 50k events/s with Kafka and ClickHouse; discussed back-pressure and exactly-once trade-offs clearly.

## Coding (Maya)

Finished both problems; clean tests, good naming.

## Values (Riya)

Gave concrete examples of disagreeing with a manager and resolving it with data.
"""

OFFSITE = r"""# Product team offsite — November 13–14

Lisbon, Portugal · Hotel Lumen, Rua das Flores 12

## Day 1

| Time | Session |
| --- | --- |
| 09:30 | Coffee and welcome |
| 10:00 | 2027 strategy: where Workflows fits |
| 12:30 | Lunch |
| 14:00 | Customer panel (remote): Northwind, Globex |
| 16:00 | Roadmap workshop |
| 19:30 | Dinner at Taberna da Rua |

## Day 2

| Time | Session |
| --- | --- |
| 09:30 | Retro: what slowed us down in 2026 |
| 11:00 | Hack morning: pick one paper cut and fix it |
| 13:00 | Demos and goodbye |

## Travel

Book through the travel portal by **November 1**. The hotel holds rooms until then.
"""

API_CHANGELOG = r"""# Metrics API v2 — changelog draft

## Breaking changes from v1

- `GET /v1/metrics/{id}/values` is now `GET /v2/metrics/{id}/series`
- Timestamps are ISO 8601 strings in UTC, not epoch seconds
- `granularity` is renamed `grain` and accepts `hour`, `day`, `week`, `month`

## New

- `POST /v2/queries` runs an ad-hoc query against any metric
- Cursor pagination with `next` on every list endpoint

```json
{
  "metric": "weekly_active_teams",
  "grain": "week",
  "series": [
    {"t": "2026-10-19T00:00:00Z", "v": 5480},
    {"t": "2026-10-26T00:00:00Z", "v": 5690}
  ],
  "next": null
}
```
"""

WORKFLOWS_LANDING = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acme Workflows — beta</title>
<style>
  :root { --o:#E8590C; --ink:#16181D }
  * { box-sizing:border-box; margin:0; padding:0 }
  body { font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif; color:var(--ink); background:#fff }
  header { display:flex; justify-content:space-between; align-items:center; padding:22px 48px; border-bottom:1px solid #eee }
  .logo { display:flex; gap:10px; align-items:center; font-weight:800; font-size:20px }
  .logo span { width:30px; height:30px; border-radius:8px; background:var(--o); color:#fff; display:grid; place-items:center }
  .hero { padding:90px 48px 70px; text-align:center; background:linear-gradient(180deg,#FFF7ED,#fff) }
  .pill { display:inline-block; background:#FFEDD5; color:var(--o); font-weight:700; border-radius:999px; padding:6px 14px; font-size:14px }
  h1 { font-size:56px; letter-spacing:-.02em; margin:22px auto 16px; max-width:820px; line-height:1.05 }
  p.sub { font-size:21px; color:#4B5563; max-width:640px; margin:0 auto 30px; line-height:1.5 }
  .cta { background:var(--o); color:#fff; border:0; border-radius:12px; padding:15px 28px; font-size:18px; font-weight:700 }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:22px; padding:50px 48px; max-width:1100px; margin:0 auto }
  .card { border:1px solid #eee; border-radius:16px; padding:26px }
  .card h3 { margin-bottom:8px; font-size:20px } .card p { color:#4B5563; line-height:1.5 }
  footer { text-align:center; color:#9CA3AF; padding:30px; font-size:14px }
</style></head>
<body>
<header><div class="logo"><span>A</span> Acme</div><nav style="color:#4B5563">Product · Pricing · Docs</nav></header>
<section class="hero"><span class="pill">Beta · January 2027</span>
<h1>When a metric moves, Workflows moves with it.</h1>
<p class="sub">Post to Slack, open a Jira ticket or call any webhook the moment a condition holds. No code, no cron jobs.</p>
<button class="cta">Request beta access</button></section>
<section class="grid">
<div class="card"><h3>Any metric, any condition</h3><p>Above, below, changes by or goes missing — on every metric you already track.</p></div>
<div class="card"><h3>Actions your team uses</h3><p>Slack, email, Jira, PagerDuty and webhooks, with templates to start from.</p></div>
<div class="card"><h3>Audit everything</h3><p>Every run is logged with the value that triggered it and what it did.</p></div>
</section>
<footer>© 2026 Acme Inc. · acme.com/workflows</footer>
</body></html>
"""

PIPELINE_CSV = """Account,Owner,Stage,Amount (USD),Close date,Probability,Next step
Northwind Logistics,Riya Sharma,Negotiation,148000,2026-11-14,80%,Security review sign-off
Globex Corporation,Alex Chen,Proposal,96000,2026-11-28,60%,Pricing call with CFO
Initech,Sam Lee,Discovery,42000,2026-12-12,25%,Technical deep dive
Umbrella Health,Riya Sharma,Proposal,210000,2026-12-05,55%,Send DPA redlines
Stark Analytics,Maya Okafor,Closed won,75000,2026-10-21,100%,Kick-off on Nov 3
Wayne Retail,Alex Chen,Negotiation,128000,2026-11-20,75%,Legal review of MSA
Hooli Cloud,Sam Lee,Qualification,30000,2027-01-15,15%,Identify champion
Vandelay Imports,Riya Sharma,Proposal,58000,2026-12-01,50%,Demo for ops team
Soylent Foods,Maya Okafor,Discovery,36000,2026-12-19,20%,Data source audit
Massive Dynamic,Alex Chen,Closed lost,90000,2026-10-10,0%,Revisit in Q2
Acme Labs EU,Riya Sharma,Negotiation,164000,2026-11-30,70%,EU residency confirmation
Pied Piper,Sam Lee,Proposal,47000,2026-12-08,45%,Trial extension
"""

Q3_PLAN = r"""# Q3 plan

Owner: Riya Sharma · Last updated October 2026

## Goals

1. Grow weekly active teams from 4,100 to 5,500
2. Cut median dashboard load time below 2 seconds
3. Sign 15 new enterprise customers

## Key results

| Goal | Metric | Target | Status |
| --- | --- | --- | --- |
| Activation | Weekly active teams | 5,500 | On track |
| Performance | Median load (s) | < 2.0 | Done |
| Revenue | New enterprise logos | 15 | At risk |

## Projects

- [x] Onboarding checklist for new workspaces
- [x] Move tile queries to the columnar store
- [ ] Workflows private beta
- [ ] SSO on the Team plan

## Risks

The enterprise target depends on two security reviews closing in September. If they slip, we move the goal to Q4 and say so in the board update.
"""

Q3_PLAN_INTERNAL = r"""# Q3 plan — internal notes

Not for the board deck. Open questions and the numbers behind the public plan.

## Hiring

- Two senior data engineers: offers out to one candidate, the other loop is next week
- Support: one engineer in APAC from November

## Budget

| Line | Planned | Actual (Sep) |
| --- | --- | --- |
| Infrastructure | $142k | $173k |
| Contractors | $40k | $31k |
| Events | $25k | $22k |

Infrastructure is 22% over because of columnar storage. Reserved capacity for 2027 brings it back under plan.

## Open questions

- Do we price Workflows per run or per seat?
- Who owns EU residency after Maya's team takes on caching?
"""

ONBOARDING_GUIDE = r"""# Onboarding guide

Welcome to Acme! This is your first-week checklist. Ask in **#new-joiners** if anything is unclear.

## Day 1

- [ ] Pick up your laptop from IT (2nd floor) and sign in with SSO
- [ ] Join **#general**, **#product** and your team channel
- [ ] Read the [getting started guide](getting-started)

## Week 1

- [ ] Shadow two customer calls
- [ ] Ship a small change to production with your onboarding buddy
- [ ] Book 1:1s with your manager and two people outside your team

## Tools

| Tool | What for | Access |
| --- | --- | --- |
| Acme Cloud | Metrics and dashboards | SSO, day 1 |
| Linear | Planning and issues | Ask your manager |
| Figma | Design files | Request in #it-help |

## Who to ask

- **Product questions:** Riya Sharma
- **Engineering setup:** Alex Chen
- **Design:** Sam Lee
"""

SALES_PLAYBOOK = r"""# Sales playbook

How we run enterprise deals at Acme. Internal: don't forward outside the company.

## Qualify

Ask in the first call:

1. Which reporting tools do you use today, and who maintains them?
2. How many people look at metrics every week?
3. What would make you switch this quarter?

## Demo

Show the customer's own data where possible: connect a read-only replica during the call. Keep the demo under 25 minutes and leave time for questions.

## Pricing guardrails

| Seats | List | Max discount without approval |
| --- | --- | --- |
| Up to 50 | $29 / seat | 10% |
| 51–250 | $24 / seat | 15% |
| 250+ | Custom | Deal desk |

## Security reviews

Send the security FAQ and the SOC 2 report under NDA. Most reviews close in two to three weeks.
"""

PRICING_FAQ = r"""# Pricing FAQ (draft)

Answers for the January 2027 pricing change. Password-protected until the announcement.

## What's changing?

Workflows becomes part of every plan, with monthly run limits: 100 on Starter, 5,000 on Team and 50,000 on Business.

## Do existing customers pay more?

No. Annual contracts keep their price until renewal, and monthly plans keep their price for six months.

## What counts as a run?

One trigger of one workflow, whatever it does. Failed runs don't count.
"""

RELEASE_22 = r"""# Release notes — v2.2

*Released August 26, 2026*

- **Funnel tile** with up to eight steps
- Dashboards remember the last date range you chose
- Fixed CSV exports that dropped the header row in some locales
"""

RELEASE_21 = r"""# Release notes — v2.1

*Released July 29, 2026*

- **Google Sheets connector** pushes on edit instead of polling
- Alert messages link straight to the tile that fired
- Faster sign-in with SSO on mobile
"""

RELEASE_20 = r"""# Release notes — v2.0

*Released June 30, 2026*

The biggest release of the year: a new dashboard editor, a mobile app and the v2 metrics API.

- **New editor:** drag tiles, resize them, and undo anything
- **Mobile app** for iOS and Android
- **Metrics API v2** with cursor pagination and ISO 8601 timestamps
"""

MEETING_OCT_21 = r"""# Product sync — October 21

**Attendees:** Riya, Alex, Sam, Maya

- Columnar store migration finished on Friday; no incidents
- Workflows design review moved to Thursday
- Sam shared three options for the dashboard empty state; we picked option B

**Action items:** Alex to write the runner load-test plan; Maya to estimate tile caching.
"""

MEETING_OCT_14 = r"""# Product sync — October 14

**Attendees:** Riya, Alex, Maya

- Q3 retro: shipped 9 of 11 planned projects
- Decided to delay SSO on Team to Q1 so Workflows beta stays on time
- Northwind asked for EU data residency; added to the risk list
"""

ROADMAP_2027 = r"""# Roadmap 2027 (draft)

Private until the planning review on November 20.

| Quarter | Theme | Big bets |
| --- | --- | --- |
| Q1 | Automate | Workflows GA, SSO for all plans |
| Q2 | Expand | EU residency, Salesforce connector v2 |
| Q3 | Explain | AI summaries of dashboard changes |
| Q4 | Scale | 10× tile throughput, usage-based pricing |
"""

INCIDENT_REPORT = r"""# Incident report — delayed Stripe syncs (Oct 9)

**Impact:** Stripe data was up to 3 hours late for 14% of workspaces between 06:10 and 09:20 UTC. No data was lost.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 06:10 | Stripe API starts returning 429s for our account |
| 06:40 | Alert fires: sync lag above 30 min |
| 07:05 | Backoff increased; queue starts draining |
| 09:20 | All workspaces caught up |

## What we're changing

- Spread syncs across the hour instead of on the hour
- Show "data delayed" on affected tiles automatically
"""

BOARD_PREP = r"""# Board prep — private notes

Questions I expect, and the honest answers.

- **Why did infrastructure go over?** Columnar storage grew faster than usage. Reserved capacity fixes it.
- **Is the enterprise target realistic?** 11 of 15 signed; two more are in legal review.
- **What would we cut if we had to?** The Q4 events budget, not hiring.
"""

CLI_README = r"""# acme-cli

![build](https://img.shields.io/badge/build-passing-brightgreen) ![version](https://img.shields.io/badge/version-1.8.0-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

The command-line tool for Acme Cloud: manage metrics as code, push dashboards from CI and tail alerts in your terminal.

## Installation

```bash
curl -fsSL https://get.acme.com/cli | sh
```

## Usage

```bash
acme login
acme metrics push ./metrics
acme alerts tail --workspace acme
```

## Contributing

Pull requests are welcome. Run `make test` before you open one.

## License

MIT
"""

API_RESPONSE_JSON = r"""{
  "metric": "weekly_active_teams",
  "workspace": "acme",
  "grain": "week",
  "unit": "teams",
  "series": [
    {"t": "2026-09-07T00:00:00Z", "v": 4820},
    {"t": "2026-09-14T00:00:00Z", "v": 4975},
    {"t": "2026-09-21T00:00:00Z", "v": 5102},
    {"t": "2026-09-28T00:00:00Z", "v": 5210},
    {"t": "2026-10-05T00:00:00Z", "v": 5347},
    {"t": "2026-10-12T00:00:00Z", "v": 5480},
    {"t": "2026-10-19T00:00:00Z", "v": 5590},
    {"t": "2026-10-26T00:00:00Z", "v": 5690}
  ],
  "summary": {"change": 0.18, "trend": "up"},
  "next": null
}
"""


def q3_dashboard_html() -> str:
    """A self-contained dashboard page: inline SVG charts, no CDN."""
    weeks = [4820, 4975, 5102, 5210, 5347, 5480, 5590, 5690]
    mx, mn = max(weeks), min(weeks)
    pts = " ".join(f"{30 + i * 90},{210 - (v - mn) / (mx - mn) * 160:.1f}" for i, v in enumerate(weeks))
    bars = [("Northwind", 148), ("Umbrella", 210), ("Acme Labs EU", 164), ("Wayne Retail", 128), ("Globex", 96)]
    bar_svg = "".join(
        f'<text x="0" y="{28 + i * 44}" font-size="14" fill="#475569">{n}</text>'
        f'<rect x="130" y="{14 + i * 44}" width="{v * 2}" height="22" rx="6" fill="#0F766E"/>'
        f'<text x="{138 + v * 2}" y="{30 + i * 44}" font-size="13" fill="#0F172A">${v}k</text>'
        for i, (n, v) in enumerate(bars))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Q3 dashboard — Acme</title>
<style>
 body{{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;background:#F8FAFC;color:#0F172A}}
 header{{padding:24px 32px;background:#fff;border-bottom:1px solid #E2E8F0;display:flex;justify-content:space-between;align-items:center}}
 h1{{font-size:22px;margin:0}} .sub{{color:#64748B;font-size:14px}}
 .grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px 32px}}
 .kpi,.panel{{background:#fff;border:1px solid #E2E8F0;border-radius:14px;padding:18px}}
 .kpi b{{display:block;font-size:28px;margin-top:6px}} .up{{color:#047857;font-size:13px;font-weight:700}}
 .row{{display:grid;grid-template-columns:3fr 2fr;gap:16px;padding:0 32px 32px}}
 h2{{font-size:15px;margin:0 0 12px;color:#334155}}
</style></head><body>
<header><div><h1>Q3 2026 dashboard</h1><div class="sub">Acme Cloud · updated October 29, 2026</div></div><div class="sub">Owner: Riya Sharma</div></header>
<section class="grid">
 <div class="kpi">MRR<b>$688k</b><span class="up">▲ 14.5% QoQ</span></div>
 <div class="kpi">Weekly active teams<b>5,690</b><span class="up">▲ 38%</span></div>
 <div class="kpi">Net revenue retention<b>124%</b><span class="up">▲ 3 pt</span></div>
 <div class="kpi">Median load<b>1.9 s</b><span class="up">▼ 2.5 s</span></div>
</section>
<section class="row">
 <div class="panel"><h2>Weekly active teams</h2><svg viewBox="0 0 700 230" width="100%"><polyline points="{pts}" fill="none" stroke="#0F766E" stroke-width="4" stroke-linejoin="round"/></svg></div>
 <div class="panel"><h2>Top open deals ($k)</h2><svg viewBox="0 0 520 230" width="100%">{bar_svg}</svg></div>
</section></body></html>"""


def help_site_files() -> dict[str, str]:
    """A small zipped website: index + guides/setup + faq + css/js (relative links)."""
    css = "body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;color:#0F172A}header{background:#0F766E;color:#fff;padding:18px 32px}header a{color:#fff;margin-right:18px;text-decoration:none;font-weight:600}main{max-width:760px;margin:32px auto;padding:0 24px;line-height:1.6}code{background:#F1F5F9;padding:2px 6px;border-radius:4px}"
    nav = '<header><a href="{r}index.html">Acme Help</a><a href="{r}guides/setup.html">Setup</a><a href="{r}faq.html">FAQ</a></header>'
    page = lambda title, body, r="": (f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>'
                                      f'<link rel="stylesheet" href="{r}css/site.css"></head><body>{nav.format(r=r)}'
                                      f'<main>{body}</main><script src="{r}js/site.js"></script></body></html>')
    return {
        "index.html": page("Acme Help", "<h1>Acme Help Center</h1><p>Guides and answers for Acme Cloud.</p><ul><li><a href='guides/setup.html'>Set up your workspace</a></li><li><a href='faq.html'>Frequently asked questions</a></li></ul><p id='year'></p>"),
        "guides/setup.html": page("Setup — Acme Help", "<h1>Set up your workspace</h1><ol><li>Create a workspace at <code>acme.com/start</code></li><li>Connect a data source</li><li>Invite your team</li></ol>", "../"),
        "faq.html": page("FAQ — Acme Help", "<h1>FAQ</h1><h3>Is there a free plan?</h3><p>Yes, Starter is free for up to three people.</p><h3>Where is my data stored?</h3><p>In the region you choose.</p>"),
        "css/site.css": css,
        "js/site.js": "document.getElementById('year')&&(document.getElementById('year').textContent='© '+new Date().getFullYear()+' Acme Inc.');",
    }
