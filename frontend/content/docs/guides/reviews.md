---
title: Reviews
description: Require a review before a guide is published. How editors submit changes, and how reviewers and admins approve them or ask for changes.
updated: 2026-10-31
prerequisites: [/guides/publishing, /guides/members-and-roles]
keywords: [review, approval, approve, request changes, submit for review, withdraw, reviewer, publishing workflow]
---

With reviews on, editors and reviewers can't publish a guide directly. They submit their changes, and a reviewer or an admin approves them, which publishes, or sends them back with a note.

## Turn reviews on

A Guides admin opens the guide's **Settings** and, under **Reviews**, turns on **Editors and reviewers submit changes for approval before they're published**. The **Require reviews** link on the Publish tab goes there too.

![The Reviews card in Settings › People and reviews with Require a review before publishing turned on: "Editors send changes to a reviewer; admins can still publish. Reviewers approve other people's changes, never their own."](/docs-assets/guides/reviews/review-setting.webp)

Admins can always publish, reviews or not.

## Submit changes for review

On the **Publish** tab, an editor or reviewer sees **Send for review** instead of the Publish form, and the bar's button says **Send for review** too.

::::steps
### Write a note
Under **Note for the reviewer**, say what changed and why. A note is required.

### Submit
Choose **Send for review**. The card changes to **Waiting for review**, with when you sent it.
::::

![Acme Help Center's Publish tab for an editor: Send for review, "This guide requires a review before it's published", a Note for the reviewer, "The guide's reviewers and admins will be asked", Send for review and Preview first, and under it Readers see now.](/docs-assets/guides/reviews/review-submit.webp)

A guide has one open review at a time. You can keep editing while it's open: when it's approved, what's published is the drafts **as they are then**, including edits made after you submitted.

To take it back, choose **Withdraw**. Your drafts stay as they are. Only the person who submitted a review, or an admin, can withdraw it.

## Approve or request changes

Reviewers and admins see open reviews at the top of the guide's **Publish** tab: who wants to publish, how many changes, and their note, with **Compare** to see them line by line. The changes themselves are listed below, each with **Compare**. Open the **Publish** tab to check for reviews: Markdrop Guides doesn't send notifications for them yet.

![A review card: "Priya wants to publish 2 changes", her note about the refund window, with Approve and publish, Request changes and Compare.](/docs-assets/guides/reviews/review-waiting.webp)

- **Approve and publish** publishes straight away. If that publish can't start (for example the day's publishes are used up), the review stays open.
- **Request changes** asks **What should change** and sends the review back with your note. The drafts stay as they are.

::clip{src="/docs-assets/guides/reviews/review-approve" alt="Noah, a reviewer, choosing Approve and publish on Priya's review; the Publish tab shows the publish's progress, then Your guide is live for acme-help.guides.markdrop.in with the message Publish #2 is live."}

![The Request changes dialog: "Send back to Priya", with a note asking to say working days and to link to Change your plan.](/docs-assets/guides/reviews/request-changes.webp)

A reviewer can't approve their own changes: someone else has to. An admin can approve their own.

## Who does what

| | Submit | Approve or request changes | Publish without a review |
| --- | --- | --- | --- |
| **Admin** | Yes | Yes, including their own | Yes |
| **Reviewer** | Yes | Other people's changes | No |
| **Editor** | Yes | No | No |
| **Viewer** | No | No | No |

See [Members and roles](/guides/members-and-roles).

## Related

- [Members and roles](/guides/members-and-roles): who reviews.
- [Publish your guide](/guides/publishing): what happens after approval.
