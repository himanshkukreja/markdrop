---
title: Frequently asked questions
description: Short answers about accounts, sharing, workspaces, domains, analytics, peer-to-peer transfers and your data.
updated: 2026-10-30
keywords: [faq, questions, help, account, free, delete account, who can see]
---

## Accounts

:::details[Do I need an account?]
Not to write and publish a document. You need a free account to upload files, use workspaces, keep what you publish together in a dashboard, and see analytics. Sending files peer to peer needs no account on either side. See [Accounts](/get-started/accounts).
:::

:::details[How do I sign in?]
With Google, or with your email: Markdrop emails you a code each time, with no password. Your first sign-in creates the account.
:::

:::details[How do I delete my account?]
There's no delete button in Settings yet. Email Markdrop from the address you signed in with, using the contact on the [privacy policy](https://markdrop.in/privacy).
:::

## Sharing and access

:::details[Can workspace admins open my private items?]
No. Items set to "Only people added" open only for their owner and the people added by name. No workspace role opens them, not even Admin. See [Workspace privacy](/workspaces/privacy#what-each-item-setting-means).
:::

:::details[If I share a folder, does it open everything inside?]
No. A folder link never opens anything by itself. Each visitor sees only the items they could already open. See [Share a folder](/workspaces/share-a-folder).
:::

:::details[What happens to my files if I leave a workspace, or it's deleted?]
You keep them. When you leave, files you added stay in the workspace and you still own them. When a workspace is deleted, every file goes back to the person who owns it, with the same link and analytics; anything that was open to the team becomes "Only people added".
:::

## Domains

:::details[Will my markdrop.in links break when I add my own domain?]
No. markdrop.in links keep working. Your domain is an extra address for the same documents.
:::

:::details[Can I use my apex domain, like acme.com?]
Yes. An apex domain uses an A record pointing at `76.76.21.21` instead of a CNAME. A subdomain like `docs.acme.com` is the usual choice. See [Put your workspace on your own domain](/workspaces/custom-domain).
:::

:::details[How many domains can a workspace have?]
Up to 25. One of them is the default, used for shared links and preview cards; every live domain serves.
:::

## Analytics

:::details[Can I see who opened my document?]
No. You see totals and patterns: views, people, how far they read, countries and devices. Markdrop never shows you who someone is. See [What gets counted](/analytics/what-gets-counted).
:::

:::details[Do my own views count?]
Not while you're signed in. If you open your own link signed out, Markdrop can't tell it's you, and the view counts.
:::

:::details[Who can see a document's analytics?]
Only its owner. Workspace admins don't see analytics for documents they don't own.
:::

## Sending files peer to peer

:::details[Are files I send peer to peer stored on Markdrop?]
No. They go straight from your device to the other person's, encrypted. If the networks can't reach each other directly, an encrypted relay forwards the bytes and can't read them. See [Send files peer to peer](/share/send-files).
:::

:::details[How big a file can I send peer to peer?]
There's no limit, but the receiving browser holds each file in memory, so very large files are easier to receive with the [Markdrop CLI](/cli/send-and-receive), which writes straight to disk.
:::

:::details[Can I close the tab while someone downloads?]
No. The files come from your device, so closing or reloading the tab ends the share.
:::

## Your data

:::details[Does Markdrop store my readers' IP addresses?]
No. It stores a salted hash of the IP address, and the approximate location looked up from it. See [Privacy at Markdrop](/security/privacy).
:::

:::details[Can an uploaded HTML page read my Markdrop account?]
No. Uploaded files open from a separate site, inside a sandboxed frame, so their scripts can't reach your sign-in or anything else markdrop.in keeps in your browser. See [How files are served](/security/how-files-are-served).
:::
