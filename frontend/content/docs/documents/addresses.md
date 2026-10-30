---
title: Choose a link for your document
description: Pick a custom link like markdrop.in/q3-plan, change it later, and know which addresses are reserved.
updated: 2026-10-30
keywords: [slug, url, custom link, rename, address, change url]
---

Every document and file has an address. By default Markdrop picks a short random one, like `markdrop.in/7Hk2mPq`. You can choose your own instead, such as `markdrop.in/q3-plan`, and change it later.

## Choose a link when you publish

In the editor, choose the **Link** chip (it says **Random link** until you set it) and type the part after `markdrop.in/`. Leave it blank for a short random link, made of 7 letters and digits that are hard to confuse (no `0`, `1`, `O`, `I` or `l`).

A link can be 3 to 50 characters long, using letters, numbers, hyphens (`-`) and underscores (`_`). Links are case-sensitive: `markdrop.in/Q3-Plan` and `markdrop.in/q3-plan` are different addresses.

When you upload a file, the link fills in from the file name. `Q3 Board Deck.pdf` becomes `q3-board-deck`: accents are folded (`résumé` → `resume`), spaces and punctuation become hyphens, and the result is cut to 40 characters. You can change it before you publish.

### When a link is taken

If someone else already uses the link, Markdrop says so and keeps everything you entered. Choose another one.

### Reserved links

Some words are the addresses of Markdrop's own pages, so no document can use them. They include `new`, `upload`, `share`, `login`, `dashboard`, `settings`, `builder`, `admin`, `api`, `mcp`, `privacy`, `shared`, `recent` and `requests`, in any letter case. If you pick one, Markdrop asks you to choose another.

## Change a link

If you're signed in and own the document:

::::steps
### Open My files
Find the document in **My files**.

### Choose Change URL
Open the row's menu and choose **Change URL**.

### Type the new link
Type it after `markdrop.in/` and choose **Change URL**.
::::

For a file, you can also open it, press :kbd[Esc] or choose **Show details** to leave full screen, and choose **More artifact actions › Settings**. Edit **Link** and choose **Save changes**.

Views and analytics stay with the document.

### What happens to the old link

The old address keeps pointing at the document for anyone who can open it: they're redirected to the new one. People who can't open the document get the same answer as before, and the old address never tells them the new one.

As long as the document exists, nobody else can take the old address. It stays attached to this document.

:::note
Only the document's owner can change its link from the app. The API also accepts the document's edit secret. See [Edit with your edit secret](/documents/edit-key).
:::

## After you delete a document

When a document is deleted or expires, its link is held for 30 days. During that time only you, as its owner, can publish at that address again. A document published without an account has no owner, so its link is held for everyone.

## Links on your own domain

A document filed in a workspace that has its own domain also has an address there, made of the folder path and the link: `docs.acme.com/guides/setup`. The `markdrop.in/setup` address keeps working too. See [Put your workspace on your own domain](/workspaces/custom-domain) and [Folders](/workspaces/folders).

## Related

- [Publish your first document](/get-started/first-document)
- [Passwords and expiry](/documents/passwords-and-expiry)
