---
title: Link previews
description: What the preview card shows when you paste a link to a Markdrop document, file, folder or workspace into Slack, WhatsApp or X, and what it never shows.
updated: 2026-11-04
keywords: [og image, open graph, unfurl, preview card, slack, whatsapp, social card, folder link, workspace link, folder preview]
---

When you paste a Markdrop link into Slack, Teams, WhatsApp, LinkedIn, X or iMessage, the app shows a preview card. Markdrop draws that card for each document, and it shows only what a stranger opening the link could already see.

## What the card shows

For a document anyone with the link can open, the card has:

- the title, or the document's opening heading, or else its address;
- the first lines of the text, as plain text;
- a reading time, like "4 min read";
- the address, like `markdrop.in/q3-plan`.

![The link preview card for markdrop.in/q3-plan: the Markdrop name, the title Q3 plan, the first lines of the text, the address and "1 min read".](/docs-assets/documents/link-previews/art-preview-card.webp)

For a file, the card shows the title (or the file name), its type and size. A video that anyone with the link can open also shows its poster frame.

The page's own title and description, which some apps show instead of the card, follow the same rules.

## What it never shows

Anything a stranger couldn't open gets a card with no content: no title, no text, nothing from the document except the address the link already shows. The card says only what kind of lock it has, such as "Private document" or "Password-protected document". That covers documents that are:

- set to **Only people added** or to a workspace team;
- protected by a password;
- in a workspace where visitors must sign in;
- end-to-end encrypted.

![A content-free link preview card for markdrop.in/sales-playbook that says only "Private document" and "Only people with access can open it", with no title or text.](/docs-assets/documents/link-previews/art-preview-card-private.webp)

An encrypted document's title and text are ciphertext to Markdrop, so its card reads "Encrypted document" and nothing more. A link to a document that doesn't exist, or has expired, gets a plain Markdrop card that doesn't say whether it ever existed.

:::note[Previews already posted]
Chat apps store a card when the link is first posted. If you add a password or make a document private afterwards, Markdrop asks for a fresh card on future pastes, but a card already sitting in a conversation is kept by that app. Markdrop can't recall it.
:::

## Folders and workspaces

Links to a workspace or a folder, like `markdrop.in/w/…/f/…`, and [folder share links](/workspaces/share-a-folder) (`markdrop.in/f/…`) get a card too. It shows the folder's name, "A folder in Acme" and how many items are in it, or, for a workspace, its name and how many items it holds, in the workspace's brand.

A card names a folder or a workspace only when someone who isn't signed in could already see that name:

- a folder shared with **Anyone with the link**, and the folders inside it that list something such a visitor can open;
- a folder or workspace of a workspace with its own [domain](/workspaces/custom-domain), when the domain's index shows it to visitors.

Every other folder or workspace gets a card that names nothing: "A folder in a Markdrop workspace" (or "A Markdrop workspace") and "Sign in to open it", with no folder, workspace or domain name.

Any other markdrop.in address, like the home page or **New document**, shows a Markdrop card, so no link is pasted bare. A [Send files](/share/send-files) link gets a file-transfer card that says nothing about the files.

## Cards on your own domain

A document filed in a workspace wears that workspace's brand on its card, its site name and accent colour, wherever the link is pasted. A workspace can also hide the Markdrop name from its cards. See [Brand your workspace](/workspaces/branding).

For a document strangers can't open, the workspace's branding shows only when the link is on the workspace's own domain, like `docs.acme.com/…`. On a `markdrop.in` link, even the workspace's name would be more than a stranger could learn, so it's left off.

## Previews count as shares

Each time an app fetches a card, Markdrop notes which app asked: Slack, LinkedIn, WhatsApp, Facebook, Telegram, X, Discord, Teams, Google Chat, or another. It counts as a share signal in your analytics, never as a view, and repeat fetches from the same app within 10 minutes count once. See [What gets counted](/analytics/what-gets-counted).

## Change what the card says

Edit the document's title, or its opening heading and first lines. Apps refetch cards on their own schedule, so a new paste can take a few minutes to show the change, and old pastes keep their old card.

## Related

- [Who can open what](/sharing/who-can-open)
- [End-to-end encryption](/sharing/end-to-end-encryption)
- [Passwords and expiry](/documents/passwords-and-expiry)
