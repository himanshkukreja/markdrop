---
title: Privacy at Markdrop
description: What Markdrop keeps about you and your readers, what it measures, what it never records, and how to opt out.
updated: 2026-11-07
keywords: [privacy, viewers, who viewed, view history, search log, content gaps, gdpr, cookies, consent, analytics, posthog, google analytics, global privacy control, delete account, data]
---

This page explains, in plain terms, what Markdrop keeps and why. The [privacy policy](https://markdrop.in/privacy) is the formal version.

## What you publish

Documents and files you publish are stored so the link can show them. Anyone with a link set to **Anyone with the link** can open it. Private, password-protected and workspace items are checked before they open. See [Who can open a link](/sharing/who-can-open).

[End-to-end encrypted](/sharing/end-to-end-encryption) documents are encrypted in your browser. Markdrop's servers store only the encrypted text and never receive the key — the part of the link after `#` — or the document's password, if it has one. Anyone with the full link (and the password) can read it, and Markdrop can't recover either. Markdrop still sees the link name, the size of the encrypted text (rounded), dates, view counts and who it's shared with, and the page code that does the encrypting is served by Markdrop. Images from other sites in an encrypted document load only when the reader chooses, because loading them tells those sites the reader's IP address.

Documents you set to expire are deleted when they expire. You can delete anything you own from your dashboard.

## Your account

Publishing Markdown needs no account. Uploading files, workspaces and the dashboard need a free one. Markdrop keeps your email address, your name and picture if you sign in with Google, and the documents you own.

There's no delete button in Settings yet. To delete your account and everything in it, email Markdrop from the address you signed in with, using the contact on the [privacy policy](https://markdrop.in/privacy).

## What your readers' visits record

When someone opens your link, Markdrop counts the view for your analytics. It stores a salted hash of their IP address, never the address itself, and the approximate location looked up from it. Your own views aren't counted.

The [Viewers](/analytics/viewers) tab also lists each view: a signed-in viewer by name and email address, everyone else as an anonymous **Visitor**, with where they opened it from (city, region and country), on what (device, operating system and browser with versions, the app, screen size and language), where they came from, and a timeline of what they did in it. Only the owner sees this, and for an item in a workspace its admins and editors; the workspace's viewers see the number of views only.

When **you** open someone else's document or file while signed in, its owner sees your name with your view. In **Settings → Account → Your views of other people's items** you can take your name off all of them; they stay as anonymous views.

Reading and watching sessions are deleted after 395 days, and each view's detail on the Viewers tab after 180 days. [What gets counted](/analytics/what-gets-counted) has the full list.

## What searching a workspace records

When you search inside a workspace, Markdrop keeps the words you searched for, which workspace, how many results there were, and whether you opened one. It doesn't keep who searched: no account, no IP address. Typing a longer version of the same search updates one record instead of adding one per keystroke. Searches that look like an email address or a long number aren't kept, and neither are searches outside a workspace. Records are deleted after 90 days.

The workspace's owners and admins see these searches only as totals, in [What people couldn't find](/analytics/content-gaps).

## What Ask keeps

[Ask](/workspaces/ask-markdrop) keeps your conversations so you can return to them and ask follow-ups: each question, its answer and the sources it cited. Only you can see them. When you reopen one, every source is checked against your access again, and an answer whose sources you can no longer open is hidden. A conversation is deleted 90 days after its last question, or when you remove it or select **Clear** under **Recent questions**.

## How Markdrop measures its own site

Markdrop uses three kinds of analytics to understand how the product is used and what to fix:

- **Its own analytics**: page views, time on page, where visits come from, and product events such as "published". No cookies: a random id in your browser's storage. Your IP address is used once to look up your country and city and isn't stored. Each visit is kept for about 13 months. The record of the random id itself goes about 13 months after its last visit.
- **PostHog**: product analytics and session recordings: pages, clicks and scrolling, and a replay of how each page was used. When you sign in, your visits are linked to your account's email.
- **Google Analytics**: aggregate traffic reports.

PostHog and Google Analytics never receive:

- document and file links (a document is reported as an anonymous reference, never its address),
- anything after `#` in a link, including encryption keys and sign-in or invite tokens,
- anything at all from an encrypted document's page: they don't run there,
- what you write or publish: a replay shows the page around a document or file, never its content. Documents, files, editors, previews and lists of your documents are blanked out, titles, names and email addresses are hidden, and every text field is masked,
- a replay of a sign-in link or of Markdrop's admin pages: those are never recorded,
- the contents or names of files you send peer to peer.

PostHog and Google Analytics run on markdrop.in, guides.markdrop.in and docs.markdrop.in only, never on a workspace's own domain or on a published guide.

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
- Anthropic (the Claude models behind the AI in pages, search, Ask, meetings, Team, analytics, Jira drafts and Markdrop Guides): only the text a request needs, when someone uses AI. For analytics that's totals and your own titles, never who visited. Markdrop keeps usage counts, not the text sent; the one exception is your own [Ask conversations](#what-ask-keeps), kept for you to return to. Nothing sent is used to train models. See [AI and your data](/security/ai-and-your-data).

Markdrop doesn't sell personal data, and doesn't use it for advertising.

## Email

Markdrop sends sign-in codes, notifications you trigger, and occasional product updates. Every update has an unsubscribe link. The [weekly analytics email](/analytics/weekly-email) has its own switch in Settings.
