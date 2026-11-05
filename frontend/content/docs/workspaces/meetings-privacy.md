---
title: Meetings privacy and cost
nav: Privacy and cost
description: Who can open a meeting, restricting meetings to their attendees, how long transcripts are kept, the language of the AI sections, and the Meetings AI budget.
updated: 2026-11-05
keywords: [meetings privacy, restrict to attendees, attendees only, restricted meetings, who can see a meeting, delete meeting, retention, transcript storage, english, hindi, language, meetings ai, ai limits, cost, budget, claude haiku]
---

## Who can see a meeting

- **The team, for calls with three or more people.** Everyone in the workspace can open the meeting page and its transcript, like any page set to **Workspace**. See [Privacy](/workspaces/privacy).
- **The attendees, for 1:1s and two-person calls.** A call with one or two people in it (the attendees, plus the organizer) starts [restricted to its attendees](#restricted-meetings), whichever way it comes in: manual, automatic, Drive links, Import past meetings and AI apps. Change it in the meeting's **Details**.
- **Answers follow your access.** Ask this meeting and Ask across meetings use only the meetings you can open. Each meeting is checked again when you ask, and every source in an answer is checked again before you see it. A meeting restricted from you never reaches the AI when you ask.
- **Past meetings are quiet.** Meetings brought in from your Drive's history when you [connect Google Meet](/workspaces/meetings-auto-import#past-meetings) notify nobody; their @mentions stay links.
- **Automatic imports are yours.** A meeting that [Connect Google Meet](/workspaces/meetings-auto-import) imported belongs to the person who connected it, as if they had imported it by hand.

## Restricted meetings

Restrict a meeting to its attendees and only the attendees who are members of the workspace can open it, its transcript, and its answers.

- **When you import manually**, the import dialog's **Only the people who were there** switch starts on for a 1:1 or a two-person call. Switch it on or off before you import. In [Import past meetings](/workspaces/meetings-import#import-past-meetings), each row says **Attendees** or **Team**, and you can switch it.
- **For automatic imports**, 1:1s and two-person calls are restricted, and calls with three or more people are open to the team. Switch on **Only the people in each meeting can open its page** when you connect Google Meet to restrict every meeting the script imports. To change it, make a new script.
- **Later**, from the meeting's **Details**. Only the person who imported it can switch this.

Other members don't see a restricted meeting in lists, search or answers. Workspace admins and owners see that it exists, without its title, so they can delete it.

## Delete and retention

The person who imported a meeting can delete it, and so can workspace **admins and owners**, for any meeting, even a restricted one. Its pages go to [Trash](/documents/trash) for 30 days, and the stored transcript the AI answers from is deleted at once. Until then, Markdrop keeps the transcript for as long as the meeting exists.

Disconnecting Google Meet doesn't delete meetings it already imported. Markdrop never deletes or changes anything in your Google Drive.

## Language

Everything AI writes is in **English**, even when the call mixes Hindi and English or another language. The transcript stays as it was spoken, and Google's notes are kept as written.

## AI and cost

Transcripts are sent only to the AI model, Claude Haiku 5.5, and only to answer you or to write the meeting's sections. They are never used to train models.

Meetings uses its own budget, **Meetings AI**: $5 a day and $50 a month across Markdrop. A summary costs about a fifth of a cent for an hour-long call, and a question costs less. Automatic imports count towards the same budget.

When a limit is reached, imports still work, manual and automatic, but without the AI sections. Select **Write it again** later. [Import past meetings](/workspaces/meetings-import#import-past-meetings) is the exception: it waits for the budget to reset and then carries on, so every past meeting gets its summary. Meetings AI is also off in a workspace whose AI features are turned off. In that case meetings import with their transcript and Google's notes only.

## Related

- [Meetings](/workspaces/meetings)
- [Privacy](/workspaces/privacy)
- [Import meetings automatically](/workspaces/meetings-auto-import)
