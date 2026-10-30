---
title: Share with specific people
description: Add people by email with Can view or Can edit, email them a note, let them share it on, and remove them later.
updated: 2026-10-30
prerequisites: [/get-started/accounts]
keywords: [share, invite, email, grant, collaborator, can view, can edit, reshare]
---

Add people by email when a document or file is for them and not for everyone with the link. They sign in with that address and it opens. You can give each person **Can view** or **Can edit**, and take it back whenever you like.

::video{id="share-with-people" title="Share with specific people" duration="0:45"}

## Add people

::::steps
### Open Share
From **My files**, choose **Share…** in the row's menu. Or open the document or file, press :kbd[Esc] or choose **Show details** to leave full screen, and choose **Share** (on a file, **More artifact actions › Share**).

### Type their addresses
Under **People with access**, type an address in **Add people by email** and press :kbd[Enter]. Add as many as you like. Suggestions come from people you've shared with before and from your workspaces, never from a search of other Markdrop users.

### Choose their access
Pick **Can view** or **Can edit** for the people you're adding.

### Decide whether to email them
Once you've typed an address, an **Email them** checkbox appears, ticked. Choose **Add a message** to include a note of up to 500 characters, like "Here's the Q3 plan for Thursday." Untick **Email them** to add people quietly.

### Choose Share
Markdrop confirms what happened, for example "Shared with alice@acme.com and emailed them."
::::

If the email couldn't be sent, they still have access, and the toast says "the email didn't send". Send them the link yourself.

:::tip[Make it only for them]
Adding people doesn't close the link to everyone else. If the document is set to **Anyone with the link**, switch **Who can open it** to **Only people added** in the same dialog. See [Who can open what](/sharing/who-can-open).
:::

## What they need to do

Nothing up front. They don't need an account before you share. When they open the link, Markdrop asks them to sign in, and they sign in with the address you typed: with Google, or with a code emailed to that address. Their first sign-in creates their account.

Everything shared with them appears under **Shared with me** in the sidebar.

They must sign in with exactly that address. If you added `alice@acme.com` and she signs in as `alice@gmail.com`, she sees "You don't have access yet" and can [request access](/sharing/request-access).

## What Can view and Can edit allow

| | Can view | Can edit |
| --- | --- | --- |
| Open and read it | Yes | Yes |
| Edit the text, or replace the file | No | Yes |
| Change the password, expiry or link, or delete it | No | No |
| Change who can open it | No | No |

When an editor opens the editor, Markdrop tells them: "You can edit the text. Its password, expiry, link and who can open it stay with its owner."

## The list of people

**People with access** shows:

- you, as **Owner**;
- **Everyone in {workspace}** and how many people that is, when the document is in a workspace and isn't set to **Only people added** (**Members can edit**);
- each person you added, with **Can view** or **Can edit**.

A person marked "Added without an email" was added with **Email them** off. One marked "No longer active: whoever shared it lost access" was added by someone who no longer has access themselves, so their access went with it.

To remove someone, open the `⋯` menu on their row and choose **Remove**. They lose access straight away. People you added can remove themselves with **Remove me**.

## Let people share it on

Turn on **Let people I share with add others** to let the people you added share it with others. They can never give more access than they have: someone with **Can view** can only add people with **Can view**.

If you remove someone, everyone they added loses the access that came through them.

It's on by default for documents outside a workspace, and off by default for documents filed in one.

## Limits

- A document can be shared with up to 200 people.
- Sharing can be passed on through at most 10 people in a row. Past that, Markdrop asks them to ask the owner.
- You can add up to 60 people an hour.

## Encrypted documents

Adding someone to an end-to-end encrypted document lets them fetch it, but they still need the full link, including the part after `#`. Send them the whole link. See [End-to-end encryption](/sharing/end-to-end-encryption).

## Related

- [Who can open what](/sharing/who-can-open)
- [Request access](/sharing/request-access)
- [Members and roles](/workspaces/members-and-roles)
