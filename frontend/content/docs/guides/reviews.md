---
title: Reviews
description: Require a review before a guide is published. How editors submit changes, and how reviewers and admins approve them or ask for changes.
updated: 2026-10-31
prerequisites: [/guides/publishing, /guides/members-and-roles]
keywords: [review, approval, approve, request changes, submit for review, withdraw, reviewer, publishing workflow]
---

With reviews on, editors and reviewers can't publish a guide directly. They submit their changes, and a reviewer or an admin approves them, which publishes, or sends them back with a note.

## Turn reviews on

A Guides admin opens the guide's **Settings** and, under **Reviews**, turns on **Editors and reviewers submit changes for approval before they're published**. The **Require reviews** link on the Publishes tab goes there too.

![The Reviews card in guide settings with the switch "Editors and reviewers submit changes for approval before they're published" turned on, and the note "Admins can always publish. Reviewers approve other people's changes, never their own."](/docs-assets/guides/reviews/review-setting.webp)

Admins can always publish, reviews or not.

## Submit changes for review

On the **Publishes** tab, an editor or reviewer sees **This guide requires a review** instead of the Publish form.

::::steps
### Write a note
Under **Note for the reviewer**, say what changed and why. A note is required.

### Submit
Choose **Submit for review**. The card changes to **Waiting for review**, with when you sent it.
::::

![Acme Help Center's Publishes tab for an editor: 2 changes since the last publish, This guide requires a review, a Note for the reviewer, and Submit for review.](/docs-assets/guides/reviews/review-submit.webp)

A guide has one open review at a time. You can keep editing while it's open: when it's approved, what's published is the drafts **as they are then**, including edits made after you submitted.

To take it back, choose **Withdraw**. Your drafts stay as they are. Only the person who submitted a review, or an admin, can withdraw it.

## Approve or request changes

Reviewers and admins see open reviews at the top of the guide's **Publishes** tab: who wants to publish, how many changes, and their note. The changes themselves are listed on the left, each with **View changes**. Open the **Publishes** tab to check for reviews: Markdrop Guides doesn't send notifications for them yet.

![A review card: "Priya wants to publish 2 changes", her note about the refund window, with Approve and publish and Request changes.](/docs-assets/guides/reviews/review-waiting.webp)

- **Approve and publish** publishes straight away. If that publish can't start (for example the day's publishes are used up), the review stays open.
- **Request changes** asks **What should change** and sends the review back with your note. The drafts stay as they are.

::clip{src="/docs-assets/guides/reviews/review-approve" alt="Noah, a reviewer, choosing Approve and publish on Priya's review; the publish starts, and the guide goes live with Published. Live at acme-help.guides.markdrop.in."}

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
