---
title: How files are served
description: Why uploaded files open from a separate site, how protected files use short-lived links, and what Markdrop stores for passwords and keys.
updated: 2026-10-30
keywords: [security, isolation, sandbox, origin, signed url, html, xss, passwords, edit key, encryption]
---

Markdrop shows two kinds of things: documents written in Markdown, and files you upload, like HTML pages, PDFs, spreadsheets and videos. Files can contain anything, including scripts, so Markdrop serves them in a way that keeps them away from your account.

## Files open from a separate site

Documents render on markdrop.in. Uploaded files don't: they're served from a separate site, a different domain from markdrop.in, and shown inside a frame on the document page.

That separation is the main protection. Your browser keeps your Markdrop sign-in, and the edit keys and passwords you've used, in storage that belongs to markdrop.in. A script in an uploaded HTML page runs on the other site, so it can't read any of that.

The frame is sandboxed, and the file site adds protective headers to every response: browsers must not guess file types, links don't pass on the page's address, and search engines are asked not to index files.

## Only safe types open in the page

Markdrop accepts a fixed list of file types (see [Supported file types](/files/supported-types)). The file site displays those it knows how to show safely. Anything else is offered as a download instead of opening in the browser.

## Protected files use short-lived links

A file is public only when all of these are true:

- it's set to **Anyone with the link**,
- it has no password,
- its workspace isn't [Locked](/workspaces/privacy#the-three-presets), and
- it hasn't expired.

Anything else is protected. When someone who's allowed in opens a protected file, Markdrop gives their browser a signed link that works only for that file and expires after 15 minutes, or 4 hours for video and audio so playback isn't cut off. Without a valid signed link, the file site refuses to serve a protected file.

When you narrow who can open a file, for example by adding a password, making it private, or locking the workspace, every signed link already handed out stops working at once.

:::note[A short cache window]
Public files may be cached for up to 5 minutes. If you narrow access to a file that was public, a cached copy can still be served for up to 5 minutes.
:::

Old versions of a file are never public. See [Replace a file and versions](/files/replace-and-versions).

## Passwords, edit keys and encryption

- **Read passwords** are stored as bcrypt hashes, never as the password itself. Too many wrong guesses for a document from one place are refused for a while.
- **Edit keys** (they start with `sk_`) are stored as bcrypt hashes. You can rotate one if it leaks. See [Your edit key](/documents/edit-key).
- **End-to-end encrypted documents** are encrypted in your browser with AES-256-GCM. The key is in the part of the link after `#k=`, which browsers never send to a server, so Markdrop stores only ciphertext and can't read it. See [End-to-end encryption](/sharing/end-to-end-encryption).

## Workspace logos and favicons

Branding images are decoded and re-encoded as fresh PNG files before they're stored. Only the pixels survive, so a file can't smuggle anything else through. See [Brand your workspace](/workspaces/branding).

## Custom domains

A workspace's own domain serves documents only after its owner proves control of the domain with a DNS record, and Markdrop re-checks that every day. A domain whose records stop pointing at Markdrop stops serving after three days. Readers who sign in there get a sign-in that works only on that domain, can only read, and lasts 12 hours. See [Sign-in on your domain](/workspaces/sign-in-on-your-domain).
