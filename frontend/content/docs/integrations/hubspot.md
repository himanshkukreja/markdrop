---
title: HubSpot
description: Your team's calls written up in HubSpot on the right deal, a folder per open deal, suggested deal updates, pre-call briefs and your pipeline in Ask.
updated: 2026-11-19
keywords: [hubspot, crm, deal, deals, contact, contacts, company, pipeline, stage, deal stage, amount, close date, deal owner, sales, sales team, log to hubspot, log calls, log calls automatically, internal notes, hs_internal_meeting_notes, meeting notes, call notes, booked meeting, scheduling link, hubspot zoom, duplicate, no duplicates, tasks, hubspot tasks, action items, approve, service key, service keys, private app, legacy private app, access token, pat-, scopes, crm.objects.contacts.read, crm.objects.contacts.write, crm.objects.companies.read, crm.objects.deals.read, crm.objects.owners.read, crm.objects.deals.write, pick the deal, change match, match again, disconnect, hubspot_status, hubspot_match, log_to_hubspot, hubspot_tasks, suggested updates, suggest deal updates, apply, dismiss, evidence, next step, competitor, budget, decision maker, account page, account pages, accounts folder, pre-call brief, pre-call briefs, before the call, slack, log from slack, create tasks from slack, stop these, pipeline, deals at risk, at risk, no call in 14 days, close date passed, weekly brief, ask, hubspot_suggestions, hubspot_account, hubspot_pipeline, hubspot_notifications, deal folders, deal folder, deals section, deals board, deal page, deal overview, sync now, closed won, closed lost, sales assets, attachments, emails, sales-email-read, files.ui_hidden.read, hubspot_list_deals, hubspot_deal_folder, hubspot_sync_deals]
---

Connect your company's HubSpot account and one team's calls, for example **Sales**, get written up in HubSpot without anyone typing notes: each meeting is matched to its HubSpot meeting, contacts, company and deal, and **Log to HubSpot** puts the summary, next steps and decisions in that meeting's **internal notes**, with a link back to the Markdrop page. Action items become HubSpot tasks once someone approves them.

- **HubSpot books, Markdrop writes it up.** Keep HubSpot's own Zoom connection and scheduling links: they create the HubSpot meeting on the contact and deal when a call is booked. Markdrop fills **that** meeting. It never makes a second one.
- **One team.** Only the chosen team's meetings, such as calls that come in from [Zoom](/integrations/zoom), and only for people who can open the meeting and are in that team (or are workspace admins).
- **Nothing automatic unless you say so.** Logging is one click. **Log calls automatically** is off until a workspace admin turns it on, and tasks always wait for someone to approve them.
- **The deal kept up to date, by you.** After a call, Markdrop [suggests changes to the deal](#suggested-deal-updates) with the lines of the call that support them; nothing changes in HubSpot until someone applies one.
- **Everything about a deal in one place.** Each open deal gets a [deal folder](#deal-folders) in the team's **Deals** section: its calls, HubSpot's history of it, and the team's sales assets.
- **Ready before the next call.** Team members get a [pre-call brief](#pre-call-briefs) before their HubSpot meetings. [Ask](#your-pipeline-in-ask-and-the-weekly-brief) knows your pipeline.

## Set up HubSpot

A HubSpot super admin (or someone with HubSpot's *Developer tools access* permission) creates the key; a Markdrop workspace admin saves it.

1. In HubSpot, go to **Development › Keys › Service keys** and choose **Create service key**. Name it "Markdrop".
2. Choose **Add new scope** and tick these five:

   | Scope | Why |
   | --- | --- |
   | `crm.objects.contacts.read` | Find attendees' contacts, and read the meetings and tasks on them. |
   | `crm.objects.contacts.write` | Write the call into the HubSpot meeting and create tasks. |
   | `crm.objects.companies.read` | See the contacts' companies. |
   | `crm.objects.deals.read` | Find the deal, its stage, amount and close date. |
   | `crm.objects.owners.read` | Match the call's host to their HubSpot user, and assign tasks. |

   HubSpot has no separate scopes for meetings and tasks: its activities are covered by the contacts scopes.

   To let people **apply** [suggested deal updates](#suggested-deal-updates), also tick `crm.objects.deals.write` (it lets Markdrop change a deal, only when someone chooses Apply). Everything else works without it.

   Two more read scopes fill in the [deal folders](#deal-folders); without them the folders work and say what's missing:

   | Scope | Why |
   | --- | --- |
   | `sales-email-read` | Show what the deal's emails say (subject and a short preview). Without it HubSpot leaves their content out. |
   | `files.ui_hidden.read` | Show the names of files attached to the deal's notes, emails and meetings (HubSpot keeps those as hidden files). |
3. Choose **Create**, then **Show** and **Copy** under the key.
4. In Markdrop, open **Workspace settings › Integrations › HubSpot**, paste the key, pick the team and choose **Connect and check**.

Markdrop checks the key with HubSpot: which HubSpot account it's for and which scopes are missing (the card lists them). HubSpot doesn't say whether a service key can write, so the card notes that `crm.objects.contacts.write` wasn't checked; make sure it's ticked. A private app created before HubSpot stopped offering them (October 2026) works too: paste its access token instead.

One HubSpot account connects to one Markdrop workspace.


## What Markdrop writes to HubSpot

Markdrop never deletes anything in HubSpot and never overwrites what people wrote there. Every request it sends is checked against this list first, and anything else is refused before it reaches HubSpot:

| Markdrop may | Never |
| --- | --- |
| Read contacts, companies, deals, owners and meetings | Delete any record |
| Add its notes to a call's **internal notes** (your own notes there are kept) | Change a meeting's description, title or time |
| Create a meeting when HubSpot has none for the call | Change contacts or companies |
| Create tasks you approved | Create or change deals |
| Link a meeting or task to its contact, company and deal | Remove links |

Changing a deal field (from **Apply** on a suggested update) is off unless a workspace admin turns on deal updates, and the HubSpot key also needs `crm.objects.deals.write`. A read-only key (only `.read` permissions) makes HubSpot refuse every write as well.

## How a call is matched

A team meeting shows its deal under its title (**💼 Company — Deal · Stage**, linking to the [deal's page](#deal-folders)), where the call's HubSpot actions are. Markdrop looks for the call in this order:

1. **The meeting HubSpot booked.** A HubSpot meeting owned by the call's host (their HubSpot user has the same email as their Markdrop account) that starts within 15 minutes of the call. Its contacts, company and deal come with it. This is the surest match, and the meeting Log fills.
2. **The attendees.** Attendees' emails (or, without emails, their full names) are looked up as HubSpot contacts, then their companies, then their **open** deals; the most recently active deal is picked and any others are offered.
3. **Nothing found.** The meeting shows **Pick the deal** under its title: search HubSpot's deals by name and choose one.

The deal's page shows its name, stage, amount, owner and close date, the contacts and company, each linking to HubSpot. The deal under the meeting's title also offers **Change deal**, to pick another deal (or none), and **Match again**, to look again, for example after the deal was created in HubSpot. A deal someone picked is never replaced by an automatic match.

## Log to HubSpot

Choose **Log to HubSpot** on the call in its deal's **Calls** tab (or from the deal under the meeting's title). Markdrop writes into the HubSpot meeting's **internal notes**:

- a link to the meeting in Markdrop (only people who can open it there can read it),
- the summary,
- the next steps, with who and when,
- the decisions.

The meeting's description, the part HubSpot shares with attendees, is never changed, and notes your reps typed into the internal notes stay: Markdrop replaces only its own block, between **Call notes from Markdrop** and **End of Markdrop notes**.

If HubSpot didn't book a meeting for the call, Markdrop creates one, as a completed meeting owned by the host, on the matched deal, contacts and company. Either way Markdrop remembers it: logging again (say after the summary was rewritten) updates the same HubSpot meeting, never a new one. The deal's **Calls** tab shows when each call was logged.

### Log calls automatically

Off by default. A workspace admin turns it on in the HubSpot card. Then, when a new call's summary is written and Markdrop matched it to **the meeting HubSpot booked**, the notes go to HubSpot on their own. Calls matched only through their attendees, and past meetings brought in with Import past meetings, still wait for someone to choose Log to HubSpot.

## Tasks

On the deal's **Calls** tab, **Create tasks** lists a call's action items as HubSpot tasks, each with:

- **a due date**: the one said in the call (for example "by Friday", counted from the call's date), else three days after the call;
- **an owner**: the person named, when they're a HubSpot user with the same email, else the deal's owner, else the call's host.

Tick the ones you want and choose **Create tasks in HubSpot**. Each task is created on the deal and contacts, with a link back to the meeting, and is marked **In HubSpot**. A task is created once: approving it again never makes a duplicate.

## Suggested deal updates

When a team call matched to a deal has its summary, Markdrop reads the call's notes and the parts of the transcript about money, dates, competitors and decisions, and suggests changes to the deal. They're listed under **Suggested updates** on the deal's page ([Overview](#deal-folders)):

- **Stage**: only a stage of the deal's own pipeline, and only a move the call shows (for example, they asked for a proposal).
- **Close date** and **Amount**: only when a date or a figure was said in the call.
- **Next step**: one short sentence.
- **Your own fields**: when your HubSpot account has deal fields for a **competitor**, a **budget** or a **decision maker**, those too (only fields that exist and can be changed; a field with options gets one of its options).

Each suggestion shows the current value, the new one and the lines that support it, with their time in the transcript (choose the time to jump there). Choose **Apply** to change that one field of the deal in HubSpot, or **Dismiss** to hide it. Nothing is ever applied on its own, and Markdrop remembers what was applied and dismissed: **Suggest again** keeps those choices. Suggestions use the meetings AI's [fair-use limits](/security/ai-and-your-data#fair-use-limits).

Apply needs the `crm.objects.deals.write` scope on the key. Without it, Apply says so and the HubSpot card lists the scope as missing: add it to the key in HubSpot, then apply again.

## Deal folders

Every **open** deal in the connected HubSpot account, in every pipeline, gets a folder for the HubSpot team: its calls, what HubSpot knows about it and the team's sales assets, in one place. Only the HubSpot team's members (and workspace admins) see deals; no other team does.

Open the team in the sidebar and choose **Deals**. The header shows how many deals are open, what the pipeline is worth, when the deals were last synced, and **Open HubSpot**. Under it, one row of controls:

- **Board** (the default): a column per pipeline stage with its deal count and total amount. A card shows the deal, its company, the owner, the amount, the close date and how many calls it has. A deal without calls says **No calls yet**; a deal whose last call was more than 14 days ago says **Quiet N days**. A long stage shows its five biggest deals first, then **Show N more**; an empty stage folds into a thin strip. The board scrolls sideways on its own; the page doesn't.
- **List**: the same deals as a table. Choose a column heading to sort by it (again to reverse).
- **Filters**: owner, company, and **No call in 14 days**. **Group by company** puts a company's deals together.
- **Closed deals.** A deal that closes keeps its folder, marked **Closed won** or **Closed lost**. A deal that was already closed gets a folder as soon as one of the team's calls is matched to it (closed deals without calls get none). Calls keep arriving in a closed deal's folder, for example support and training calls after signing. Its name and stage are read again a few times a day; a deal that reopens updates like an open one. Turn on **Show closed** to add Closed won and Closed lost columns.
- **All your teams.** If you're in HubSpot teams in more than one workspace, **Deals** at the top of the sidebar shows them together, with a **Team** filter.

![The Sales team's Deals board in Acme: 17 open deals worth $1.2M, synced 12 minutes ago, Board and List, owner and company filters, No call in 14 days, Group by company and Show closed; a column per stage with its count and total, and deal cards with company, owner, amount, close date and calls, No calls yet and Quiet 18 days badges.](/docs-assets/integrations/hubspot/deals-board.webp)

![The same deals as a list: deal and company, stage, amount (sorted, largest first), owner, close date, and calls with the last one and Quiet badges.](/docs-assets/integrations/hubspot/deals-list.webp)

Choose a deal to open its page. The header has the company and deal, its stage (or **Closed won** / **Closed lost**), amount, owner, close date and calls, **Open in HubSpot** and **Upload asset**. The tabs:

- **Overview**: the deal's facts and contacts (name, title, email) on the left. On the right, the [suggested deal updates](#suggested-deal-updates) waiting for someone, **Across all calls** (decisions, objections and risks, open questions and next steps, each linking to its call) and the three most recent calls with their length and a play button when the recording was kept. A deal without calls shows one short note instead.
- **Calls**: the deal's calls, newest first, each with **Log to HubSpot** and **Create tasks**. Calls waiting for someone to [pick the deal](#calls-in-a-deal-folder) are listed here too.
- **Assets**: files the team uploads there (ordinary Markdrop files, with their views and [view analytics](/analytics/overview)), and the files attached to the deal in HubSpot, which open in HubSpot. Drop files on the box, or choose **Upload asset**.
- **HubSpot activity**: the deal's notes, emails (subject, a short preview and whether it was sent or received), meetings and tasks, newest first.

![A deal page: the company and deal name with its stage, amount, owner, close date and calls, Open in HubSpot and Upload asset; tabs Overview, Calls, Assets and HubSpot activity; the deal's facts, Team notes and contacts on the left, suggested deal updates (a stage and a close date, each with the line that supports it, Apply and Dismiss), Across all calls and Recent calls on the right.](/docs-assets/integrations/hubspot/deal-page.webp)

![A deal's Calls tab: a call waiting for someone to pick the deal with File here, then five calls, newest first, each with its action items and when it was logged, Log to HubSpot or Update in HubSpot, and Create tasks.](/docs-assets/integrations/hubspot/deal-calls.webp)

Each deal folder also has a **Deal overview** page (**Team notes** on the deal page): an ordinary page with the same facts and history in a section Markdrop keeps up to date. Write the team's own notes above or below the section; they stay.

### Calls in a deal folder

A call matched to a deal moves into its folder: the meeting page with its transcript. Who can open it doesn't change, and it stays in the team's **Meetings** and in search. A call moves on its own when the match is sure: the meeting HubSpot booked on the deal, a deal someone picked, or attendees whose company has exactly one open deal.

When the attendees' company has **several open deals**, Markdrop doesn't guess: the meeting shows **Pick the deal**, and each of those deals lists the call under **Calls**. Choose **File here** on the right deal (or pick it from the meeting). Picking another deal later moves the call there.

If someone moves a call out of its deal folder, it stays where they put it.

### Updates and Sync now

HubSpot doesn't tell Markdrop when a deal changes, so Markdrop checks every 20 minutes: new open deals get their folder, and renamed deals, stages, amounts and owners follow. With many deals it reads the ones that changed first and catches up over a few rounds. Workspace admins can choose **Sync now** in the Deals section.

Deal folders only **read** HubSpot: nothing here writes to it. The folders live in a **Deals** folder of the team that's kept out of the file tree (search still finds what's in it).

### Account pages

Deals replaced the company **account pages**. No new ones are made, and existing ones were moved to an **Accounts (archived)** folder of the team, where they can still be read.

## Pre-call briefs

About an hour before a team member's HubSpot meeting with a contact or deal (meetings HubSpot has for them, as their HubSpot user), they get a **pre-call brief** in Slack (when Markdrop for Slack is connected) and in their Markdrop inbox:

- the deal's stage, amount, close date and owner;
- the last call with that deal or company: its summary, follow-ups and open questions (only a call they can open);
- a link to the deal.

Each brief is sent once. Turn yours off in **Settings › Account › HubSpot**, or with **Stop these** on the message. A workspace admin can turn them off for everyone in the HubSpot card.

## In Slack: Log and Create tasks

With [Markdrop for Slack](/integrations/slack) connected, when a team call's summary is ready, its host gets one Slack message: the deal, how many updates are suggested, and the buttons **Log to HubSpot** and **Create tasks** for the call's action items. Only the person it was sent to can use the buttons, and nothing goes to HubSpot until they click. Turn these messages off in **Settings › Account › HubSpot**, or with **Stop these**.

## Your pipeline in Ask and the weekly brief

- **Ask.** For the HubSpot team's members and workspace admins, [Ask](/workspaces/ask-markdrop) reads the HubSpot deals (stage, amount, close date, owner, last contact and the team's last call) when a question is about deals: "Which proposal-stage deals had no call in two weeks?" Markdrop keeps a copy for ten minutes to spare HubSpot's limits.
- **Weekly brief.** The HubSpot team's [weekly brief](/teams/team-home#the-weekly-brief) gets **Pipeline** lines: deals that moved stage since last week, and deals at risk (no call in 14 days, or the close date passed). Only people who may use HubSpot see these lines.

## The HubSpot card

**Workspace settings › Integrations › HubSpot** shows the connected HubSpot account, the team, how many calls and tasks were logged, **Log calls automatically**, and switches for **Suggest deal updates**, **Pre-call briefs** and **Slack buttons after calls** (all on until an admin turns them off). Workspace admins can change the team, paste a new key (**Change key**) and disconnect. If the team is **open**, everyone in the workspace can read its meetings: the card suggests making it **private**.

![The connected HubSpot card: calls from Sales (private), the HubSpot account and who connected it, 41 calls and 58 tasks logged, Log calls automatically off, Suggest deal updates, Pre-call briefs and Slack buttons after calls on, Change key and Disconnect HubSpot.](/docs-assets/integrations/hubspot/card.webp)

### If something doesn't work

- **"Pick the deal"**: the call's HubSpot meeting wasn't found (a different host, more than 15 minutes apart, or not booked through HubSpot) and no attendee matched a contact. Search for the deal.
- **"The HubSpot key is missing scopes"**: in HubSpot, open the key, choose **Edit**, add the scopes the card lists, then save the key in Markdrop again.
- **"HubSpot no longer accepts the key"**: the key was rotated or deleted. Paste the new one with **Change key**.
- **"HubSpot asked Markdrop to slow down"**: HubSpot limits how fast apps call it. Markdrop waits and retries; if it still says so, try again in a minute.

## Disconnect

Choose **Disconnect HubSpot…** in the card. Markdrop deletes the key, the HubSpot users and stages it kept for a few hours, and every meeting's match, right away. Deal folders stay with their pages, calls and assets (they're the team's), without HubSpot's activity, and show in the team's file tree. Notes and tasks already in HubSpot are your company's records and stay there. Markdrop keeps only the IDs of the HubSpot meetings and tasks it wrote, so connecting the same account again updates them instead of duplicating them. You can also delete the key in HubSpot.

## Privacy

- The key is stored **encrypted**. Only workspace admins see the card's setup details, never the key.
- Only the chosen team's meetings are matched or sent, only by people who can open them and are in the team, and only to the HubSpot account connected to that workspace.
- Markdrop sends the summary, next steps, decisions and a link. The transcript and the recording never go to HubSpot. A suggested deal update reaches HubSpot only when someone applies it.
- Deal folders, pre-call briefs, Pipeline lines and Ask's deal list are shown only to the HubSpot team's members and workspace admins. A call restricted to its attendees stays restricted in its deal folder and is left out of the deal's roll-up.
- Files attached in HubSpot are never copied into Markdrop: they're listed by name and open in HubSpot.
- See the [privacy policy](https://markdrop.in/privacy#hubspot) for the whole picture. Questions? See [Get help](/help/support).

## From an AI app

With the [MCP server](/ai/tools#hubspot), an assistant can check the connection (`hubspot_status`), see a meeting's deal and how it matched, search deals and pick one (`hubspot_match`), log the call (`log_to_hubspot`), list or create its tasks (`hubspot_tasks`), list, apply or dismiss suggested deal updates (`hubspot_suggestions`), read or update an existing account page (`hubspot_account`), see the pipeline and the deals at risk (`hubspot_pipeline`), list the team's deal folders (`hubspot_list_deals`), read one deal's folder with its calls, roll-up and HubSpot activity (`hubspot_deal_folder`), sync the deals now (`hubspot_sync_deals`, workspace admins) and turn your own pre-call briefs and Slack messages on or off (`hubspot_notifications`), with the same rules as the meeting panel. Connecting is done in the HubSpot card.
