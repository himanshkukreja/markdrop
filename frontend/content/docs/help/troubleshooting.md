---
title: Troubleshooting
description: Fixes for the problems people hit most - signing in, links that won't open, uploads, invitations, domains, analytics and transfers.
updated: 2026-10-30
keywords: [help, problem, error, not working, can't sign in, link broken, 404, 429, upload failed, troubleshoot]
---

Find the message you see, or the thing that isn't working. Each answer says what it means and what to do.

## Signing in

:::details[I didn't get the sign-in code]
Check your spam or junk folder, and that you typed the address correctly. Choose **Resend code** to get a new one. Codes are 6 digits and expire after 15 minutes. You can also choose **Continue with Google** instead.
:::

:::details[Too many tries in a short time]
You've entered too many wrong codes or asked for too many codes in a row. Wait a minute and try again. Each code allows 5 tries.
:::

:::details[That sign-in link has expired]
Sign-in links work once and only for a short time. Enter your email to get a new one.
:::

:::details[Your Google email isn't verified]
Verify the address with Google first, or sign in with your email and a code instead.
:::

## A link won't open

:::details[Nothing at this link]
The document may have expired or been deleted, or the address has a typo. Ask the person who sent it for a fresh link. If you own it, check its expiry in your dashboard.
:::

:::details[This document is private]
It's shared with specific people. Sign in with the address it was shared with and it opens.
:::

:::details[You don't have access]
The document is shared with specific people, and the account you're signed in with isn't one of them. Most often, you're signed in with a personal address and it was shared with your work address, or the other way round. Sign out and sign in with the other address, or ask the owner for access. See [Request access](/sharing/request-access).
:::

:::details[This document is password protected]
Enter the password you were given. After too many wrong passwords, Markdrop asks you to wait a few minutes before trying again.
:::

:::details[It opens on markdrop.in but not on our own domain]
On a workspace's own domain you sign in separately. Choose **Sign in** in the domain's header. See [Sign-in on your domain](/workspaces/sign-in-on-your-domain).
:::

## Uploading files

:::details[That file is too big]
One file can be up to 25 MB, and video and audio up to 2 GB. For bigger things, send them [peer to peer](/share/send-files) instead. See [Limits](/account/limits).
:::

:::details[Storage quota exceeded]
Your account holds up to 20 GB, and old versions of files count toward it. Delete files you no longer need, or old versions, then try again. See [Replace a file and versions](/files/replace-and-versions).
:::

:::details[My file downloads instead of opening]
Markdrop shows a fixed list of file types in the page. Anything else is offered as a download. See [Supported file types](/files/supported-types).
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
