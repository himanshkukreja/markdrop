---
title: Troubleshooting
description: Fixes for the problems people hit most - signing in, links that won't open, uploads, pages, invitations, domains, analytics and transfers.
updated: 2026-11-05
keywords: [help, problem, can't edit page, can't type, is editing, edit anyway, conflict, keep both, page locked, leave anyway, not saved, notifications iphone, error, not working, can't sign in, link broken, 404, 429, upload failed, troubleshoot]
---

Find the message you see, or the thing that isn't working. Each answer says what it means and what to do.

## Signing in

:::details[I didn't get the sign-in code]
Check your spam or junk folder, and that you typed the address correctly. Choose **Resend code** to get a new one. Codes are 6 digits and expire after 15 minutes. You can also choose **Continue with Google** instead.
:::

:::details[Too many tries in a short time]
Your network asked for too many codes, or tried too many codes, in a short time. The limit counts everyone on the same network. Wait a minute and try again.
:::

:::details[That code didn't work]
The code is wrong, has expired, or has had 5 wrong tries. After 5 wrong tries a code stops working, even the right one. Choose **Resend code** and use the code in the newest email.
:::

:::details[That sign-in link has expired]
Sign-in links work once and only for a short time. Enter your email to get a new one.
:::

:::details[Your Google email isn't verified]
Verify the address with Google first, or sign in with your email and a code instead.
:::

## A link won't open

:::details[Nothing at this link]
The document may have expired or been deleted, or the address has a typo. Ask the person who sent it for a fresh link. When a document expires, Markdrop deletes it: it's gone from **My files** too, and it can't be recovered. If it was yours, publish it again.
:::

:::details[This document is private]
It's shared with specific people. Sign in with the address it was shared with and it opens.
:::

:::details[You don't have access]
The document is shared with specific people, and the account you're signed in with isn't one of them. Most often, you're signed in with a personal address and it was shared with your work address, or the other way round. Sign out and sign in with the other address, or ask the owner for access. See [Request access](/sharing/request-access).
:::

:::details[This document is password protected]
Enter the password you were given. After too many wrong passwords, Markdrop stops checking for a few minutes and shows an error even for the right one. Wait a few minutes and try again.
:::

:::details[It opens on markdrop.in but not on our own domain]
A workspace's own domain has its own sign-in. Markdrop carries yours across in the background if you're a member of the workspace, or if you chose **Don't ask again** for that domain. Otherwise choose **Sign in** in the domain's header once and confirm the site. If you're signed in on markdrop.in and the domain still asks, reload the page after a couple of minutes, or choose **Sign in**. See [Sign-in on your domain](/workspaces/sign-in-on-your-domain).
:::

## Uploading files

:::details[That file is too big]
One file can be up to 25 MB, and video and audio up to 2 GB. For bigger things, send them [peer to peer](/share/send-files) instead. See [Limits](/account/limits).
:::

:::details[Storage quota exceeded]
Your account holds up to 20 GB, and old versions of files count toward it. Delete files you no longer need, or old versions from a file's **Settings**, then try again. See [Replace a file and versions](/files/replace-and-versions).
:::

:::details[My file type isn't accepted]
Markdrop takes a fixed list of file types. Anything else is refused when you upload it, with "Unsupported file type…". See [Supported file types](/files/supported-types) for the list. For a site with several files, zip it and upload it as a [website](/files/websites). For any other kind of file, [send it peer to peer](/share/send-files).
:::

## Pages

:::details[I can't type in a page]
Pages open in View mode, for reading. Choose **Edit** in the top bar, or press :kbd[E], to open the editor, and **Done** when you're finished. If there's no **Edit**, you can only read the page: choose **Request edit access** in its **⋯** menu. See [View and Edit](/pages/overview#view-and-edit).
:::

:::details[Someone is editing — you'll be able to edit when they're done]
One person edits a page at a time, and only while they're changing it. The page frees itself when they choose **Done** or leave, after two minutes without a change, or a minute after their tab goes to the background, and becomes editable for you without a reload. The page's owner and workspace admins can choose **Edit anyway**; what the other person hadn't saved is kept in version history. See [Editing together](/pages/editing-together).
:::

:::details[Someone else changed the same part of this page while you were editing]
You and someone else (or an AI app) changed the same lines. Choose **Keep both** to get their version and then yours, **Use theirs** or **Use mine**. Their changes to other parts of the page stay either way. See [When two changes meet](/pages/working-together#when-two-changes-meet).
:::

:::details[Your latest changes aren't saved yet, so the editor stays open]
**Done** couldn't save, usually because you're offline or someone took over the page. Wait for **Saved** in the top bar and choose **Done** again. **Leave anyway** goes back to reading and keeps your changes in this browser: the next time you open the page, choose **Restore them**.
:::

:::details[This page is locked by its owner, so it can't be edited]
The page's owner or a workspace admin chose **Lock page**. Only they can edit it, or choose **Unlock page** in the editor's **⋯** menu. See [Page options](/pages/overview#page-options).
:::

:::details[My AI app says the page is locked or someone is editing it]
While someone is editing a page, AI apps can't change it, except to add blocks to the end. The app is told who it is and when the page will be free, and can try again then. If you own the page or are a workspace admin, the app can take over with `take_over: true`. See [From an AI app](/pages/editing-together#from-an-ai-app).
:::

:::details[I don't get notifications on my iPhone]
On an iPhone or iPad, notifications work only in the installed app (iOS 16.4 or later). [Install Markdrop](/get-started/install-app), open it from your Home Screen, and turn notifications on in **Settings › Account** inside the app. See [Push notifications](/pages/mentions-and-notifications#push-notifications).
:::

## Workspaces and domains

:::details[The invitation says it was sent to a different address]
Workspace invitations work only for the address they were sent to. Sign in to Markdrop as that address, then open the link again.
:::

:::details[This invitation has expired]
Invitations last 7 days. Ask an admin of the workspace to choose **Resend**.
:::

:::details[My domain won't verify]
See [If it doesn't verify](/workspaces/custom-domain#if-it-doesnt-verify) on the custom domain page. The most common cause is a DNS panel that adds your domain to the record name a second time.
:::

:::details[My domain shows Lapsed]
Its DNS records stopped pointing at Markdrop for three days, so it stopped serving. Put both records back, then choose **Check DNS again**. Links on markdrop.in kept working throughout.
:::

:::details[I can't change a setting: it says Admins only]
That setting needs the Admin role. Ask the workspace's owner or an admin. See [Members and roles](/workspaces/members-and-roles).
:::

## Analytics

:::details[My own visits are showing up]
Your own views are left out only while you're signed in. Sign in on the browser you use to check your links.
:::

:::details[My numbers look lower than expected]
Views from your workspace's members are hidden by default; turn off **Hide views from … members** on the item's **Audience** tab to include them. Bots and link previews aren't counted as views. See [What gets counted](/analytics/what-gets-counted).
:::

:::details[There's no reading or watching data for some visits]
Visitors whose browsers send Global Privacy Control don't send reading or watching data. Very short visits (under 2 seconds of activity, with nothing played) aren't kept as sessions.
:::

## Sending files peer to peer

See [Troubleshooting peer-to-peer transfers](/share/troubleshooting) for every message, and what to try when a transfer is slow.

## Too many requests

If the API or an app answers with HTTP status `429`, you've sent too many requests in a short time. Wait a moment and try again. See [Limits](/account/limits#request-rates).

## Still stuck?

Check the [FAQ](/help/faq). For anything about your account or your data, use the contact on the [privacy policy](https://markdrop.in/privacy).
