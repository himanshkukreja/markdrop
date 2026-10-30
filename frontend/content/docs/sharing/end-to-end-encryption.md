---
title: End-to-end encryption
description: Encrypt a document in your browser before it's published. The key lives in the link after #, so Markdrop stores ciphertext it has no key for.
updated: 2026-10-30
keywords: [e2e, encryption, encrypt, aes-gcm, zero knowledge, key, fragment, privacy]
---

Turn on encryption and your browser encrypts the document's title and text before anything is sent. The key goes in the link, after the `#`, which browsers never send to a server. Markdrop stores ciphertext it has no key for.

The trade-off is plain: **the link is the key**. Anyone with the full link can read the document, and if every copy of the link is lost, so is the document.

::video{id="encrypt-a-document" title="Encrypt a document in your browser" duration="0:45"}

## Encrypt a document

::::steps
### Open the editor
Go to [markdrop.in/new](https://markdrop.in/new), and write or paste your text.

### Turn on encryption
Choose the **Encrypt** chip and turn on **Encrypt in this browser**. The chip changes to **Encrypted**.

### Publish
Choose **Publish**. The button says "Encrypting in your browser…", then "Publishing…".

### Copy the whole link
The **Published** panel says "End-to-end encrypted. The key is in this link." Choose **Copy link**: it copies the address with the key, like `markdrop.in/q3-plan#k=9fQx2LmA…`.
::::

Encryption works with or without an account, and alongside a custom link, a password and an expiry. You can also turn it on in the [README builder](/documents/readme-builder).

## How it works

- Your browser makes a new 256-bit AES-GCM key for the document.
- It encrypts the title and the text together into one sealed envelope, and sends only that. Markdrop stores no title for the document.
- The key is added to the link as `#k=…`. The part after `#` stays in the browser: it isn't sent when someone opens the link, and browsers leave it out of the `Referer` they send to other sites.
- When someone opens the full link, their browser fetches the ciphertext and decrypts it, locally.

Markdrop can't verify, read, search or recover the text. Signing in doesn't unlock it either, not even for the owner: if signing in could unlock it, the encryption wouldn't mean anything.

## Keep the link safe

:::danger[No recovery]
Lose every copy of the full link and the document can't be opened again, by anyone. Markdrop has nothing to recover it with.
:::

As a safety net, the browser you published from remembers the key. If you open the document there without the key, it opens anyway and says "Opened with the key saved in this browser", with **Copy full link** so you can get the link back. On a shared or borrowed computer, choose **More actions › Forget key on this device**.

People who open the link in a browser without the key see "This document is end-to-end encrypted. Ask whoever shared it for the full link."

## What's turned off

Because Markdrop can't read the text, some features don't work on encrypted documents:

- **Link previews** show "Encrypted document" with no title or text.
- **Google Docs export** and **VS Code sync** are off.
- **Save a copy** isn't offered, and AI assistants connected through MCP can't read or change it.
- The editor doesn't keep drafts while **Encrypt** is on.
- Search in **My files** can't find it by title; it shows the link and an **E2E** badge.

The 500,000-character limit counts the encrypted size, which is larger than your text. The meter accounts for it.

## Who can open it

Encryption sits on top of [who can open it](/sharing/who-can-open). Set it to **Only people added** and only those people can fetch the ciphertext, and they still need the full link with the key. Adding someone by email never gives them the key; send them the whole link.

## Edit and change the key

To edit, open the full link and choose **Edit**. Your browser decrypts the text, you change it, and it's encrypted again before it's saved. Without the key you can still change the password and expiry, or delete the document, but not the text.

If the link has spread further than you wanted, issue a new key: choose **Edit**, then **Settings**, turn on **Issue a new key**, and choose **Save with new key**. Markdrop shows "New key generated — this is the link now." The old link stops working. Anyone who already read the document keeps what they read.

## Files aren't encrypted

Encryption is for documents. Uploaded files, such as PDFs, pages and videos, aren't end-to-end encrypted. To limit who can open a file, use [who can open it](/sharing/who-can-open) and a [password](/documents/passwords-and-expiry).

## Related

- [Security and privacy](/security/privacy)
- [Link previews](/documents/link-previews)
- [Who can open what](/sharing/who-can-open)
