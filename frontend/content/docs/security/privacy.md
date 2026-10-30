---
title: Privacy at Markdrop
description: What Markdrop keeps about you and your readers, what it measures, what it never records, and how to opt out.
updated: 2026-10-30
keywords: [privacy, gdpr, cookies, consent, analytics, posthog, google analytics, global privacy control, delete account, data]
---

This page explains, in plain terms, what Markdrop keeps and why. The [privacy policy](https://markdrop.in/privacy) is the formal version.

## What you publish

Documents and files you publish are stored so the link can show them. Anyone with a link set to **Anyone with the link** can open it. Private, password-protected and workspace items are checked before they open. See [Who can open a link](/sharing/who-can-open).

[End-to-end encrypted](/sharing/end-to-end-encryption) documents are encrypted in your browser. Markdrop stores only ciphertext. The key is in the part of the link after `#`, which browsers never send to a server.

Documents you set to expire are deleted when they expire. You can delete anything you own from your dashboard.

## Your account

Publishing Markdown needs no account. Uploading files, workspaces and the dashboard need a free one. Markdrop keeps your email address, your name and picture if you sign in with Google, and the documents you own.

There's no delete button in Settings yet. To delete your account and everything in it, email Markdrop from the address you signed in with, using the contact on the [privacy policy](https://markdrop.in/privacy).

## What your readers' visits record

When someone opens your link, Markdrop counts the view for your analytics. It stores a salted hash of their IP address, never the address itself, and the approximate location looked up from it. You see totals and countries, never who someone is. Your own views aren't counted.

Reading and watching sessions are deleted after 395 days. [What gets counted](/analytics/what-gets-counted) has the full list.

## How Markdrop measures its own site

Markdrop uses three kinds of analytics to understand how the product is used and what to fix:

- **Its own analytics**: page views, time on page, where visits come from, and product events such as "published". No cookies: a random id in your browser's storage. Your IP address is used once to look up your country and city and isn't stored. Each visit is kept for about 13 months. The record of the random id itself goes about 13 months after its last visit.
- **PostHog**: product analytics and session recordings. When you sign in, your visits are linked to your account's email.
- **Google Analytics**: aggregate traffic reports.

PostHog and Google Analytics never receive:

- document and file links (a document is reported as an anonymous reference, never its address),
- anything after `#` in a link, including encryption keys and sign-in or invite tokens,
- what you write: editors, previews, document pages and lists of your documents aren't recorded, and every text field is masked,
- the contents or names of files you send peer to peer.

PostHog and Google Analytics run on markdrop.in only, never on a workspace's own domain.

## Cookies and your choices

Markdrop's own analytics set no cookies. PostHog and Google Analytics do.

If you're in the EU, the EEA, the UK or Switzerland, Markdrop asks first. Until you accept, PostHog counts your visit without cookies and records nothing, and Google Analytics doesn't load.

If your browser sends **Global Privacy Control** or **Do Not Track**, Markdrop treats that as a no. When you open someone's document, Global Privacy Control also means no reading or watching data goes to its owner's analytics. Your view still counts, without where you came from.

To change your choice, choose **Privacy choices** in the site's footer.

## Sending files peer to peer

Files go straight from your device to the other person's and are never stored on Markdrop's servers. If a network blocks a direct path, an encrypted relay forwards the bytes and can't read them. Markdrop keeps the name, type and size of the files, how many there were, a hashed IP, your account if you're signed in, and connection details (route, timing, browser). See [Send files peer to peer](/share/send-files).

## Who processes data for Markdrop

- Vercel (website hosting) and Amazon Web Services in Mumbai (the API).
- MongoDB Atlas (database) and Cloudflare (file storage, the file viewer and the peer-to-peer relay).
- Resend (sign-in and notification email).
- PostHog and Google (analytics, as above).

Markdrop doesn't sell personal data, and doesn't use it for advertising.

## Email

Markdrop sends sign-in codes, notifications you trigger, and occasional product updates. Every update has an unsubscribe link. The [weekly analytics email](/analytics/weekly-email) has its own switch in Settings.
