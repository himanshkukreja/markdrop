---
title: Sign-off
description: Ask one person to approve part of a page. Only they can sign, the decision is recorded with their name and time, and the section can lock.
updated: 2026-11-04
prerequisites: [/pages/overview]
keywords: [sign-off, signoff, sign off, open comments, approval, approve, approver, release approval, decision, lock, locked section, audit, history, list_signoffs, sign_off, mcp]
---

A sign-off block asks one named person to approve something on a page: a release, a spec, a legal review. Only that person can choose an option. Markdrop records the decision, who made it and when, and shows it to everyone who can read the page. Once it's signed, nobody can change the block, and it can also lock the section above it.

## Add a sign-off

1. Type **/** in a page and choose **Sign-off** (in the **Markdrop** group).
2. Choose who signs. The search lists the members of the page's workspace.
3. Give it a label, such as **Release approval**, and set its options. The defaults are **Approved** and **Not approved**. You can have up to six.
4. Optionally, tick **Lock the section above once signed**.
5. Write what's being approved inside the block, if you want to say more than the label.

The page saves as usual. The person you named is told they've been asked to sign off.

Sign-offs need a page in a workspace, because the person who signs has to be a member of it. In a personal page the block shows, but there's no one to choose.

## Sign off

The person named sees the options as buttons on the block. Everyone else sees **Waiting for** and the person's name.

Choose an option to sign. The block then shows the decision in its colour (green for an approval, red for a refusal, amber for something in between), the signer's name and the time. The page's [version history](/pages/history) gets an entry such as **Signed off by Riya: Approved for production**.

The signer can choose **Change decision** to pick another option, or **Clear my decision** to withdraw it. Every change is kept.

If [comment](/collaboration/comments) threads are still open on the page when you sign, the block says how many first and asks you to confirm: **Sign off anyway**, or **Cancel** and resolve them. Every sign-off records the discussion as it stood: how many threads were resolved and how many were still open (the block shows it, and so does the version history entry). From an AI app, `sign_off` signs and says in its answer when threads were open.

Nobody else can sign for them: not the page's owner, not a workspace admin, and not an AI app acting for someone else. The decision is stored by Markdrop, never in the page's Markdown, so editing the Markdown can't fake one.

## What a signature locks

Once a block is signed, its person, label, options, lock setting and text can't change, and the block can't be deleted. That holds for everyone who can edit the page, the owner included, in the editor, in Markdown mode, from [VS Code](/vscode/sync) and through AI apps.

With **Lock the section above once signed**, everything from the previous heading down to the block is locked too. If there's no heading above it, the lock starts at the top of the page. In the editor a thin line runs beside the locked section; hover over it to see who signed it. If you try to type there, Markdrop says why it can't change. The rest of the page stays editable.

To change a signed block or its section, the signer clears their decision first. A [workspace admin](/workspaces/members-and-roles) can also remove a signed block (the bin on the block in the editor). The removal is recorded in version history with who removed it and what the decision was. If the block comes back later, from an earlier version for example, it's unsigned.

## Where you see sign-offs

- **On the block** itself, for everyone who can read the page.
- **Under the page's title**, as a row of pills: each label and where it stands. Select one to jump to the block.
- **In version history**, as entries of their own.
- **Through AI apps**, with `list_signoffs` (below).

Names show only to the page's owner and the members of its workspace, as with [people mentioned](/pages/markdown-reference#people-and-dates) in a page. Anyone else who can read the page sees the decision and the time, and "a person" instead of the name.

## From an AI app

An AI app connected through [MCP](/ai/tools#pages) can:

- read a page's sign-offs with `list_signoffs`: each block's id, label, the person who signs, the options, the decision with who and when, and whether it locks the section above;
- sign with `sign_off`, but only when the person the app acts for is the one named. `option: null` clears the decision.

An AI app writes a sign-off block like this:

```markdown
:::signoff{#b-k3x9a1 person="<user id>" label="Release approval" options="Approved for production|Not approved" lock=above}
QA passed on staging.
:::
```

The person's id comes from `list_workspace_members`. A block written without an id gets one when the page is saved. Writing `option="Approved"` or anything like it into the block does nothing: decisions only come from `sign_off` or the block's buttons. See the [Page Markdown reference](/pages/markdown-reference#sign-off).

## Limits

| | |
| --- | --- |
| Options per block | Up to 6, each up to 80 characters |
| Label | Up to 120 characters |
| Sign-off blocks per page | 50 |
| Who signs | One person, a member of the page's workspace who can read the page |
| Changes kept per block | The last 100 |

On a workspace's own domain, readers see sign-offs but can't sign there. The person named signs on markdrop.in.
