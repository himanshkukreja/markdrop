---
title: Who can open what
description: Every document and file is open to anyone with the link, only people added, or a workspace team. Here is how each choice works with passwords and sign-in.
updated: 2026-10-30
keywords: [access, permissions, private, public, team, who can see, visibility, access level]
---

Every document and file has one setting that decides who can open it: **Who can open it**. It has three choices. Passwords, encryption and named people work on top of that setting, and this page explains how they fit together.

::video{id="who-can-open" title="Who can open what" duration="0:50"}

## The three choices

| Choice | Who can open it | Sign-in |
| --- | --- | --- |
| **Anyone with the link** | Anyone who has the address. | Not needed. |
| **{Team} team**, for example **Acme team** | Everyone in the workspace it's filed in, plus people you add by email. Nobody else, link or not. | Needed. |
| **Only people added** | You and the people you add by email. | Needed. |

**Anyone with the link** is the default. Everything published without an account uses it, and it's how Markdrop links have always worked.

The team choice is named after your workspace, so a workspace called Acme shows **Acme team**. It's only available once the document is in a workspace.

People you add by email always get in, whatever the choice, as long as they sign in with that address. See [Share with specific people](/sharing/share-with-people).

## Change it

You need to be the document's owner, signed in.

::::steps
### Open Share
On the document, choose **Share**. From **My files**, choose **Share…** in the row's menu. On a file, choose **More artifact actions › Share**.

### Pick a choice
Under **Who can open it**, choose one of the three cards. It saves straight away: "Who can open it is updated."
::::

The dialog lists every address the setting covers, for example `docs.acme.com/guides/setup` and `markdrop.in/setup`. One setting covers them all.

Narrowing takes effect at once. Make a document private and people who aren't on the list can't open it on their next visit, and links to a protected file's bytes that were already handed out stop working.

## What readers see when they can't open it

| They see | Because |
| --- | --- |
| "This document is private" and **Sign in to open** | They aren't signed in, and the document isn't open to anyone with the link. |
| "You don't have access yet" and **Request access** | They're signed in, but not with an address that has access. They can ask you. See [Request access](/sharing/request-access). |
| "This document is password protected" | It's open to anyone with the link, behind a password. |

## How the extras fit

### Passwords

A password only applies to **Anyone with the link**, and only to strangers. You, people you added, your workspace team and anyone holding the edit secret open it without the password. See [Passwords and expiry](/documents/passwords-and-expiry).

### Encryption

An end-to-end encrypted document needs the full link, with its `#k=` key, on top of everything else. Adding someone by email lets them fetch it; it doesn't give them the key. See [End-to-end encryption](/sharing/end-to-end-encryption).

### Workspaces that require sign-in

A workspace admin can turn on **Visitors must sign in to open anything**. Then nothing in that workspace is open to strangers, even items set to **Anyone with the link**: only members and people added by email get in. See [Workspace privacy](/workspaces/privacy).

### Filing doesn't change access

Putting a document in a workspace folder doesn't change who can open it. A document set to **Only people added** stays that way inside a workspace; even workspace admins can't open it unless you add them.

## What each person can do

| Person | Read | Edit the text or replace the file | Password, expiry, link, delete | Who can open it, add people |
| --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes |
| Edit secret holder | Yes | Yes | Yes | No |
| Added with **Can edit** | Yes | Yes | No | Add others, if allowed |
| Added with **Can view** | Yes | No | No | Add others, if allowed |
| Workspace member, team choice or link | Yes | Yes, except **Can view** members | No | Add others, if allowed |
| Anyone else, link choice | Yes | No | No | No |

"If allowed" means you turned on **Let people I share with add others**. See [Share with specific people](/sharing/share-with-people#let-people-share-it-on).

## More about sharing

::::cards
:::card[Share with specific people]{href="/sharing/share-with-people" icon="user"}
Add people by email with Can view or Can edit.
:::
:::card[Request access]{href="/sharing/request-access" icon="inbox"}
Ask an owner for access, or answer someone who asked you.
:::
:::card[End-to-end encryption]{href="/sharing/end-to-end-encryption" icon="lock"}
Encrypt a document so Markdrop stores only ciphertext.
:::
:::card[Workspace privacy]{href="/workspaces/privacy" icon="globe"}
Set defaults for a whole team, or require sign-in for everything.
:::
::::
