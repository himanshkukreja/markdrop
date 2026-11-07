---
title: Meetings privacy and AI
nav: Privacy and AI
description: Who can open a meeting, restricting meetings to their attendees, how long transcripts are kept, the language of the AI sections, and AI limits.
updated: 2026-11-07
keywords: [meetings privacy, restrict to attendees, attendees only, restricted meetings, only the people who were there, who can see a meeting, slack, quiet, past meetings, notifications, delete meeting, retention, transcript storage, english, hindi, language, ai limits, fair use]
---

## Who can see a meeting

- **The team, for calls with three or more people.** Everyone in the workspace can open the meeting page and its transcript, like any page set to **Workspace**. See [Privacy](/workspaces/privacy).
- **The attendees, for 1:1s and two-person calls.** A call with one or two people in it (the attendees, plus the organizer) starts [restricted to its attendees](#restricted-meetings), whichever way it comes in: manual, automatic, Drive links, Import past meetings and AI apps. Change it in the meeting's **Details**.
- **Answers follow your access.** [Ask](/workspaces/ask-markdrop) (on one meeting or across them), [meeting memory](/pages/meeting-memory) in pages and [Team](/workspaces/team#who-sees-what) use only the meetings you can open: a restricted 1:1 feeds only its attendees' Team pages and never the weekly summary. Each meeting is checked again when you ask, and every source in an answer is checked again before you see it. A meeting restricted from you never reaches the AI when you ask.
- **Meetings notify nobody.** The @mentions Markdrop writes into a meeting's notes stay links: nobody gets a bell, an email, a phone notification or a Slack message about them, however the meeting came in. Someone who edits a meeting page by hand and @mentions a person notifies them as on any page.
- **Past meetings are quiet.** Meetings brought in from your Drive's history when you [connect Google Meet](/workspaces/meetings-auto-import#past-meetings), with [Import past meetings](/workspaces/meetings-import#import-past-meetings), or held more than a day before they were imported aren't posted to your [Slack meetings channel](/integrations/slack). **Post to Slack** in a meeting's details posts one by hand.
- **Automatic imports are yours.** A meeting that [Connect Google Meet](/workspaces/meetings-auto-import) imported belongs to the person who connected it, as if they had imported it by hand.

## Restricted meetings

Restrict a meeting to its attendees and only the attendees who are members of the workspace can open it, its transcript, and its answers.

- **When you import manually**, the import dialog's **Only the people who were there** switch starts on for a 1:1 or a two-person call. Switch it on or off before you import. In [Import past meetings](/workspaces/meetings-import#import-past-meetings), each row says **Attendees** or **Team**, and you can switch it, or restrict them all with **Only the people who were there, for every meeting**.
- **For automatic imports**, 1:1s and two-person calls are restricted, and calls with three or more people are open to the team. Switch on **Only the people in each meeting can open its page** when you connect Google Meet to restrict every meeting the script imports. To change it, make a new script.
- **Later**, with **Only the people who were there** in the meeting's details (**Meeting**, bottom right of the page). Only the person who imported it can switch this. A meeting restricted because it was a 1:1 or two-person call says so there.

Other members don't see a restricted meeting in lists, search or answers. Workspace admins and owners see that it exists on the Meetings page ("A meeting restricted to its attendees", with its date but not its title), so they can delete it. The meeting page and its bar show **Only the people who were there**, and its card on the Meetings page says **Attendees only**.

## Delete and retention

The person who imported a meeting can delete it, and so can workspace **admins and owners**, for any meeting, even a restricted one. Its pages go to [Trash](/documents/trash) for 30 days, and the stored transcript the AI answers from is deleted at once. Until then, Markdrop keeps the transcript for as long as the meeting exists.

Disconnecting Google Meet doesn't delete meetings it already imported. Markdrop never deletes or changes anything in your Google Drive.

## Language

Everything AI writes is in **English**, even when the call mixes Hindi and English or another language. The transcript stays as it was spoken, and Google's notes are kept as written.

## AI

Transcripts are sent to the AI only to answer you or to write the meeting's sections, and are never used to train models. See [AI and your data](/security/ai-and-your-data).

Meeting summaries and questions have fair-use limits. When a limit is reached, imports still work, manual and automatic, with the transcript and Google's notes but without the AI sections. Select **Write it again** later to add them. [Import past meetings](/workspaces/meetings-import#import-past-meetings) is the exception: it waits until AI is available again and then carries on by itself, so every past meeting gets its summary. AI is also off in a workspace whose AI features are turned off. In that case meetings import with their transcript and Google's notes only.

## Related

- [Meetings and Team: how it fits together](/workspaces/meetings-and-team)
- [Team › Who sees what](/workspaces/team#who-sees-what)
- [Meetings](/workspaces/meetings)
- [Privacy](/workspaces/privacy)
- [Import meetings automatically](/workspaces/meetings-auto-import)
