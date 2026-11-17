---
title: HubSpot
description: Your team's calls written up in HubSpot, on the right deal, without duplicates, and their action items as tasks once you approve them.
updated: 2026-11-17
keywords: [hubspot, crm, deal, deals, contact, contacts, company, pipeline, stage, deal stage, amount, close date, deal owner, sales, sales team, log to hubspot, log calls, log calls automatically, internal notes, hs_internal_meeting_notes, meeting notes, call notes, booked meeting, scheduling link, hubspot zoom, duplicate, no duplicates, tasks, hubspot tasks, action items, approve, service key, service keys, private app, legacy private app, access token, pat-, scopes, crm.objects.contacts.read, crm.objects.contacts.write, crm.objects.companies.read, crm.objects.deals.read, crm.objects.owners.read, pick the deal, change match, match again, disconnect, hubspot_status, hubspot_match, log_to_hubspot, hubspot_tasks]
---

Connect your company's HubSpot account and one team's calls, for example **Sales**, get written up in HubSpot without anyone typing notes: each meeting is matched to its HubSpot meeting, contacts, company and deal, and **Log to HubSpot** puts the summary, next steps and decisions in that meeting's **internal notes**, with a link back to the Markdrop page. Action items become HubSpot tasks once someone approves them.

- **HubSpot books, Markdrop writes it up.** Keep HubSpot's own Zoom connection and scheduling links: they create the HubSpot meeting on the contact and deal when a call is booked. Markdrop fills **that** meeting. It never makes a second one.
- **One team.** Only the chosen team's meetings, such as calls that come in from [Zoom](/integrations/zoom), and only for people who can open the meeting and are in that team (or are workspace admins).
- **Nothing automatic unless you say so.** Logging is one click. **Log calls automatically** is off until a workspace admin turns it on, and tasks always wait for someone to approve them.

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
3. Choose **Create**, then **Show** and **Copy** under the key.
4. In Markdrop, open **Workspace settings › Integrations › HubSpot**, paste the key, pick the team and choose **Connect and check**.

Markdrop checks the key with HubSpot: which HubSpot account it's for and which scopes are missing (the card lists them). HubSpot doesn't say whether a service key can write, so the card notes that `crm.objects.contacts.write` wasn't checked; make sure it's ticked. A private app created before HubSpot stopped offering them (October 2026) works too: paste its access token instead.

One HubSpot account connects to one Markdrop workspace.

## How a call is matched

Open a meeting of the team and its **Meeting** panel shows a **HubSpot** section. Markdrop looks for the call in this order:

1. **The meeting HubSpot booked.** A HubSpot meeting owned by the call's host (their HubSpot user has the same email as their Markdrop account) that starts within 15 minutes of the call. Its contacts, company and deal come with it. This is the surest match, and the meeting Log fills.
2. **The attendees.** Attendees' emails (or, without emails, their full names) are looked up as HubSpot contacts, then their companies, then their **open** deals; the most recently active deal is picked and any others are offered.
3. **Nothing found.** The section says **Pick the deal**: search HubSpot's deals by name and choose one.

The section shows the deal's name, stage, amount, owner and close date, the contacts and company, each linking to HubSpot, and how sure the match is. **Change match** picks another deal (or none), and **Match again** looks again, for example after the deal was created in HubSpot. A deal someone picked is never replaced by an automatic match.

## Log to HubSpot

Choose **Log to HubSpot** on the meeting. Markdrop writes into the HubSpot meeting's **internal notes**:

- a link to the meeting in Markdrop (only people who can open it there can read it),
- the summary,
- the next steps, with who and when,
- the decisions.

The meeting's description, the part HubSpot shares with attendees, is never changed, and notes your reps typed into the internal notes stay: Markdrop replaces only its own block, between **Call notes from Markdrop** and **End of Markdrop notes**.

If HubSpot didn't book a meeting for the call, Markdrop creates one, as a completed meeting owned by the host, on the matched deal, contacts and company. Either way Markdrop remembers it: logging again (say after the summary was rewritten) updates the same HubSpot meeting, never a new one. The section shows when it was logged and by whom.

### Log calls automatically

Off by default. A workspace admin turns it on in the HubSpot card. Then, when a new call's summary is written and Markdrop matched it to **the meeting HubSpot booked**, the notes go to HubSpot on their own. Calls matched only through their attendees, and past meetings brought in with Import past meetings, still wait for someone to choose Log to HubSpot.

## Tasks

The section lists the meeting's action items as HubSpot tasks, each with:

- **a due date**: the one said in the call (for example "by Friday", counted from the call's date), else three days after the call;
- **an owner**: the person named, when they're a HubSpot user with the same email, else the deal's owner, else the call's host.

Tick the ones you want and choose **Create tasks in HubSpot**. Each task is created on the deal and contacts, with a link back to the meeting, and is marked **In HubSpot**. A task is created once: approving it again never makes a duplicate.

## The HubSpot card

**Workspace settings › Integrations › HubSpot** shows the connected HubSpot account, the team, how many calls and tasks were logged, and **Log calls automatically**. Workspace admins can change the team, paste a new key (**Change key**) and disconnect. If the team is **open**, everyone in the workspace can read its meetings: the card suggests making it **private**.

### If something doesn't work

- **"Pick the deal"**: the call's HubSpot meeting wasn't found (a different host, more than 15 minutes apart, or not booked through HubSpot) and no attendee matched a contact. Search for the deal.
- **"The HubSpot key is missing scopes"**: in HubSpot, open the key, choose **Edit**, add the scopes the card lists, then save the key in Markdrop again.
- **"HubSpot no longer accepts the key"**: the key was rotated or deleted. Paste the new one with **Change key**.
- **"HubSpot asked Markdrop to slow down"**: HubSpot limits how fast apps call it. Markdrop waits and retries; if it still says so, try again in a minute.

## Disconnect

Choose **Disconnect HubSpot…** in the card. Markdrop deletes the key, the HubSpot users and stages it kept for a few hours, and every meeting's match, right away. Notes and tasks already in HubSpot are your company's records and stay there. Markdrop keeps only the IDs of the HubSpot meetings and tasks it wrote, so connecting the same account again updates them instead of duplicating them. You can also delete the key in HubSpot.

## Privacy

- The key is stored **encrypted**. Only workspace admins see the card's setup details, never the key.
- Only the chosen team's meetings are matched or sent, only by people who can open them and are in the team, and only to the HubSpot account connected to that workspace.
- Markdrop sends the summary, next steps, decisions and a link. The transcript and the recording never go to HubSpot.
- See the [privacy policy](https://markdrop.in/privacy#hubspot) for the whole picture. Questions? See [Get help](/help/support).

## From an AI app

With the [MCP server](/ai/tools#hubspot), an assistant can check the connection (`hubspot_status`), see a meeting's deal and how it matched, search deals and pick one (`hubspot_match`), log the call (`log_to_hubspot`) and list or create its tasks (`hubspot_tasks`), with the same rules as the meeting panel. Connecting is done in the HubSpot card.
