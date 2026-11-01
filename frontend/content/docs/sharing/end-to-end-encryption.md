---
title: End-to-end encryption
description: Encrypt a document in your browser before it's published, with an optional password. Our servers store only the encrypted text and never receive the key.
updated: 2026-11-01
keywords: [e2e, encryption, encrypt, aes-gcm, aes-256, zero knowledge, key, fragment, password, pbkdf2, hkdf, privacy, recovery]
anchors:
  edit-and-change-the-key: issue-a-new-key-or-change-the-password
---

Encrypted in your browser. Our servers store only the encrypted text and never receive the key — the part of the link after `#`. Anyone with the full link can read it, and we can't recover it.

Turn on encryption and your browser encrypts the document's title and text before anything is sent. You can also require a password, so readers need the link *and* the password. Either way, the trade-off is plain: **the link is the key**. Share it like you'd share the document itself, and keep a copy.

::video{id="encrypt-a-document" title="Encrypt a document in your browser" duration="0:49"}

## Encrypt a document

::::steps
### Open the editor
Go to [markdrop.in/new](https://markdrop.in/new), and write or paste your text.

### Turn on encryption
Choose the **Encrypt** chip and turn on **Encrypt in this browser**. The chip changes to **Encrypted**.

To make readers type a password as well, turn on **Also require a password** and type one. See [Add a password](#add-a-password).

![The Encryption popover under the Encrypted chip above the editor: Encrypt in this browser switched on, how the key goes in the # part of the link, the warning ‘The link is the key’, and Also require a password switched on with a password typed.](/docs-assets/sharing/end-to-end-encryption/encrypt-chip.webp)

### Publish
Choose **Publish**. The button says "Encrypting in your browser…", then "Publishing…".

### Copy the whole link
The **Published** panel says "End-to-end encrypted. The key is in this link." Choose **Copy link**: it copies the address with the key, like `markdrop.in/q3-plan#k=9fQx2LmA…`. The QR code includes the key too.
::::

Encryption works with or without an account, and alongside a custom link, an expiry and [who can open it](/sharing/who-can-open). You can also turn it on in the [README builder](/documents/readme-builder).

:::tip[Leave the link name blank]
The link name isn't encrypted. A custom link like `markdrop.in/acquisition-plan` tells anyone who sees it what the document is about. Leave **Link** blank and you get a random one.
:::

## Add a password

With **Also require a password** on, opening the document takes two things: the full link and the password. The password is mixed into the key in the reader's browser. It's never sent to Markdrop, so Markdrop can't check it, reset it or tell you what it was.

A password helps when the link might end up somewhere you don't control: a chat that keeps history, a shared inbox, a browser that syncs its history. Someone who finds the link there still can't read the document.

- Under the password, a hint rates it as you type. Aim for "Strong": 16 or more characters, or four random words.
- The chip reads **Encrypted + password**.
- On an encrypted document this replaces the ordinary **Password** chip. That one is checked by Markdrop's server, which is the wrong place for a document Markdrop can't read.

:::warning[We can't reset it]
Forget the password and the document can't be opened, even with the link. Only the person who set it can help.
:::

## Share the link and the password

After you publish with a password, the **Published** panel says "End-to-end encrypted. Readers need this link and the password." It has two buttons:

- **Copy link** copies the full link, key included.
- **Copy password**, in the **Password** row, copies the password you just typed. It's kept in memory only, so it's gone after a reload.

![The Published panel for an encrypted document with a password: the link with its key chip, Copy link, a Password row with Copy password, and the advice to send the link and the password separately.](/docs-assets/sharing/end-to-end-encryption/published-password.webp)

Send them separately: the link in one message and the password in another, ideally in a different app or a phone call. If both travel together, anyone who can read that message can read the document.

## Open an encrypted document

Open the full link. The page says "Decrypting in your browser…" and then shows the document. Nothing else is asked for.

With a password, the page says "This document also needs a password". Type it and choose **Open**. The page says "Checking in your browser…" while it works, which takes a moment on purpose: the slow step is what makes guessing passwords expensive.

![The password screen of an encrypted document: This document also needs a password, a note that it's checked in this browser and never sent to our servers, a Password box and an Open button.](/docs-assets/sharing/end-to-end-encryption/password-prompt.webp)

A wrong password shows "That password doesn't open it. Check it with whoever shared the link — passwords are case-sensitive."

### Without the key

If the link was cut off, or someone copied the address without the part after `#`, the page says "This document is end-to-end encrypted. Ask whoever shared it for the full link."

If you do have the full link, choose **Have the full link? Paste it here**, paste it, and choose **Open**. The link is read in your browser; the key is never sent anywhere.

![The no-key screen: This document is end-to-end encrypted, the address with its missing #k= part highlighted, Ask whoever shared it for the full link, and a Full link box with an Open button.](/docs-assets/sharing/end-to-end-encryption/no-key-paste.webp)

### Remember the key on a device

Readers' browsers don't keep the key unless they choose to. To open the document here without the link next time, press :kbd[Esc] or choose **Show details** to leave full screen, then choose **More actions › Remember key on this device**. **Forget key on this device** undoes it. The password is never kept: a document with one asks for it each time.

The browser you published from keeps the key for you. The key is stored in that browser only and never sent to Markdrop.

## How it works

- Your browser makes a new random 256-bit key for the document.
- It encrypts the title and the text together into one sealed envelope, and sends only that. Markdrop stores no title for the document.
- The key is added to the link as `#k=…`. The part after `#` stays in the browser: it isn't sent when someone opens the link, and browsers leave it out of the `Referer` they send to other sites.
- When someone opens the full link, their browser fetches the encrypted text and decrypts it, locally.

::clip{src="/docs-assets/sharing/end-to-end-encryption/e2e-key-in-link" alt="Animation: the browser encrypts the title and text with a new key, sends only ciphertext to Markdrop, puts the key after #k= in the link, and a reader's browser fetches the ciphertext and decrypts it locally while the key never reaches the server." theme="light"}

Signing in doesn't unlock an encrypted document, not even for its owner. If signing in could unlock it, the encryption wouldn't mean anything. If you sign in while one is open, it opens again afterwards with the same key.

## What Markdrop can and can't see

| | Markdrop's servers |
|---|---|
| The title and the text | Can't see. Only the encrypted text is stored. |
| The key (after `#k=`) | Never receive it. |
| The password | Never receive it. |
| The link name | Can see. Leave it blank for a random one. |
| The size | Can see, rounded up to the next 512 bytes. |
| Dates: created, updated, expires | Can see. |
| Views, time on page and how far people scrolled | Count them, for your [analytics](/analytics/documents-and-pdfs#encrypted-documents). No content. |
| Who can open it and who it's shared with | Can see. Those are server settings. |

PostHog and Google Analytics never run on an encrypted document's page, so they record nothing there. Markdrop's own view counts still do, with no content. See [Privacy at Markdrop](/security/privacy).

## Keep the link safe

:::danger[No recovery]
Lose every copy of the full link and the document can't be opened again, by anyone. Lose the password and the same is true. Markdrop has nothing to recover either with.
:::

There are three safety nets, all in the browser:

- **A saved key.** If you open the document without the key in a browser that kept it (the one you published from, or one where a reader chose **Remember key on this device**), it opens anyway and says "Opened with the key saved in this browser", with **Copy full link** so you can get the link back.
- **A pasted link.** On the no-key screen, **Have the full link? Paste it here** opens the document from a link you find in a message or note.
- **A stale link.** If the key in the address bar doesn't open the current version but a saved key does, the saved key is used and the notice says which link works now.

On a shared or borrowed computer, forget the key when you're done: **More actions › Forget key on this device**. When you sign out of Markdrop, you're asked whether to forget every encryption key this browser saved too. Renaming a document's link keeps its saved key.

## Edit an encrypted document

Open the full link, press :kbd[Esc] or choose **Show details** to leave full screen, and choose **Edit**. Your browser decrypts the text, you change it, and it's encrypted again before it's saved, under the same link.

Without the key, the editor says "The text can't be edited without the key". You can still change the expiry or delete the document in **Settings**, but not the text.

If someone else saved the document after you opened it, your save is refused rather than written over theirs: "Not saved: there's a newer version". Choose **Copy your text**, then **Load the latest version**, and make your change again. The same happens if the owner issued a new key since you opened it.

## Issue a new key or change the password

If the link has spread further than you wanted, choose **Edit**, then **Settings**:

- Under **Encryption**, turn on **Issue a new key**, then choose **Save with new key**. Markdrop shows "New key issued — this is the link now" with the new link to copy.
- Under **Password**, type a **New password** and choose **Save with new password**, or choose **Remove the password**. A document without one has **Also require a password**.

Both need the document open with its full link, because your browser has to decrypt it to encrypt it again.

:::note[What a new key does and doesn't do]
Old links stop opening the current version. Anyone who saved an old copy can still read that copy. A new key keeps people out of what you write next; it can't take back what they already read.
:::

### Older documents with a server password

Before encrypted documents had their own password, some were published with the ordinary server-checked password. They keep working. To switch, open the document with its full link, choose **Edit › Settings**, set a password under **Password**, and tick **Remove it** under **Older server-checked password**.

## Save a copy

Anyone who can read an encrypted document can save a copy: **More actions › Save a copy**. Your browser makes the copy from the text it already decrypted, with a new link, and in your account if you're signed in.

- **Encrypted copy**: a new key, made in your browser. The original's link doesn't open the copy.
- **Unencrypted copy**: Markdrop can read it, so link previews, search and Google Docs work.

The copy has no password and no expiry.

## See how a document is protected

Choose **More actions › How this is protected**, the **E2E** badge next to the title, or **How this is protected** in the details panel. The **How this document is protected** dialog is read from the document itself:

- the format (`mdx2` or the original `mdx1`) and whether it's link key or link + password,
- where the key came from: the link, a link you pasted, or the copy saved in this browser,
- the algorithms used,
- the first characters of what Markdrop's servers actually store, and how long it is,
- what isn't encrypted.

![The How this document is protected dialog: the key never left this browser, the encryption used, the start of the encrypted text our servers store, and what isn't encrypted, with a button to remember the key on this device.](/docs-assets/sharing/end-to-end-encryption/protection-panel.webp)

## Images from other sites

An image hosted on another site is fetched from that site, which tells it the reader's IP address and that the document was opened. So in an encrypted document, those images wait: the page says "This document has images from other sites. Loading them tells those sites your IP address and that you opened it." Choose **Load images from other sites** to show them until you close the tab.

![An encrypted document with a notice that it has images from other sites, the Load images from other sites button, and an image placeholder that says which site it's from.](/docs-assets/sharing/end-to-end-encryption/remote-images.webp)

Images hosted on Markdrop load as usual.

## What's turned off

Because Markdrop can't read the text, some features don't work on encrypted documents:

- **Link previews** show "Encrypted document" with no title or text.
- **Google Docs export** and **VS Code sync** are off.
- AI assistants connected through MCP can't read or change it.
- The editor doesn't keep drafts while **Encrypt** is on.
- Search in **My files** can't find it by title; it shows the link and an **E2E** badge.

The 500,000-character limit counts the encrypted size, which is larger than your text. The meter accounts for it.

## Who can open it

Encryption sits on top of [who can open it](/sharing/who-can-open). Set it to **Only people added** and only those people can fetch the encrypted text, and they still need the full link with the key, and the password if there is one. Adding someone by email never gives them the key; send them the whole link.

## Files aren't encrypted

Encryption is for documents. Uploaded files, such as PDFs, pages and videos, aren't end-to-end encrypted. To limit who can open a file, use [who can open it](/sharing/who-can-open) and a [password](/documents/passwords-and-expiry).

## Limits

Encryption keeps the text away from Markdrop. It doesn't decide who reads it once they have the link.

- **The link is the key.** Anyone with the full link, and the password if there is one, can read the document. That includes anyone it's forwarded to.
- **Links get stored.** Browser history that syncs, chat apps, shared inboxes and email gateways that rewrite or scan links all keep the full link. Keep encrypted links out of them, or add a password and send it another way.
- **Not everything is encrypted.** The link name, the size (rounded), dates, view counts and who it's shared with are visible to Markdrop. See [What Markdrop can and can't see](#what-markdrop-can-and-cant-see).
- **No recovery.** A lost key or password can't be recovered, by you or by Markdrop.
- **You trust the page.** The code that encrypts and decrypts is served by markdrop.in. If that code were changed to send keys somewhere, encryption wouldn't protect you. That's true of every encryption that runs in a web page.
- **A saved key is as safe as the device.** Someone who can use a browser that kept the key can open the document there without the link.

## Technical details

For the curious. Everything runs in your browser with the standard Web Crypto API.

- **The key** is 32 random bytes from the browser's secure random generator, written into the link as 43 URL-safe base64 characters after `#k=`.
- **The format** is `mdx2.<header>.<ciphertext>`, both parts URL-safe base64. The 69-byte header holds the version, the mode (link key, or link key + password), the password settings, a fresh 16-byte salt and 12-byte nonce for every save, and a 32-byte key commitment.
- **Keys** come from HKDF-SHA256 over the link key and the salt: one key to encrypt and one for the commitment. With a password, the input is the link key followed by PBKDF2-SHA256 of the password, 600,000 iterations, so both are needed.
- **Encryption** is AES-256-GCM, with the whole header as additional authenticated data, so the header can't be changed either.
- **The commitment** is an HMAC-SHA256 of the header, checked before decrypting. That's how a reader is told "this key doesn't open the current version" instead of "this document may have been altered": a wrong or old key fails the commitment, while altered bytes pass it and fail decryption.
- **What's encrypted** is the title and the text together, compressed, length-prefixed and padded with zeros to the next 512-byte step, so the stored size only says roughly how long a document is.
- **Older documents** use the original `mdx1` format: AES-256-GCM straight under the link key. They keep opening forever. Saving one again writes `mdx2` under the same link, because the key is the same 32 bytes.

The [API](/api/overview) returns an encrypted document as it's stored: the envelope, with `encrypted: true` and no title. AI tools connected through MCP can't read it at all.

## Questions

:::details[Can Markdrop read my encrypted document?]
No. Markdrop's servers store only the encrypted text and never receive the key or the password. The [limits](#limits) above are what Markdrop can still see.
:::

:::details[I lost the link. Can you send it to me?]
No, Markdrop never had the key. Try the browser you published from: open `markdrop.in/your-link` there, and if it kept the key the document opens with **Copy full link**. Otherwise search your messages for the link, then use **Have the full link? Paste it here**.
:::

:::details[I forgot the password.]
It can't be reset. Ask whoever set it. If that was you and you can't remember it, the document can't be opened.
:::

:::details[Someone has the link but sees "This key doesn't open the current version".]
The owner probably issued a new key or saved over an old version. Ask them for the current link.
:::

:::details[Can I encrypt a document I've already published?]
Not in place. Publish it again with **Encrypt** on, share the new link, and delete the old document.
:::

:::details[Can I turn encryption off?]
Choose **More actions › Save a copy › Unencrypted copy**. You get a new, readable document with a new link. The encrypted one stays as it is until you delete it.
:::

:::details[Do analytics tools see what I write?]
No. PostHog and Google Analytics don't run on an encrypted document's page at all. Markdrop counts views, time and scroll depth for your analytics, never the content.
:::

:::details[Does an old encrypted document still open?]
Yes. Documents in the original format open forever, and saving one again upgrades it without changing the link.
:::

## Related

- [Security and privacy](/security/privacy)
- [Passwords and expiry](/documents/passwords-and-expiry)
- [Link previews](/documents/link-previews)
- [Who can open what](/sharing/who-can-open)
