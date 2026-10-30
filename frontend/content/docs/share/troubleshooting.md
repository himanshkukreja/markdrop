---
title: Troubleshooting peer-to-peer transfers
description: What each message means when a transfer doesn't start, stops partway or runs slowly, and what to try.
updated: 2026-10-30
prerequisites: [/share/send-files]
keywords: [p2p, transfer failed, couldn't connect, vpn, firewall, relay, slow transfer, link not active, wifi]
---

Most transfers work on the first try. When one doesn't, the message on the page tells you what happened. Find it below.

## Messages and what to do

:::details[This link isn't active]
Files are only available while the sender keeps their Markdrop tab open. The page keeps trying for about a minute before it shows this. Ask the sender to open their share page again, or to send a new link.
:::

:::details[Waiting for the sender to reconnect]
The sender's page isn't connected right now, often because their phone put it in the background. Ask them to bring the page back to the front. For the next 10 minutes, the transfer picks up on its own when they do.
:::

:::details[Couldn't connect the two devices]
Neither a direct nor a relayed route worked. A VPN or a very strict network is the usual cause. Switch off the VPN on either device, or try another network, then choose **Try again**.
:::

:::details[Too many people are downloading right now]
A link serves up to 10 people at once. Try again in a moment, once someone has finished.
:::

:::details[Someone else is receiving right now]
The sender is using the Markdrop CLI, which serves one recipient at a time. Try again once they're done, or ask the sender for a new link.
:::

:::details[The sender stopped sharing / The sender closed Markdrop]
The link is closed. Anything you already saved is yours to keep. Ask the sender to share again if you need the rest; they'll get a new link.
:::

:::details[The transfer was interrupted]
The connection dropped partway through. Files that finished are saved. Reload the link to fetch the rest. A file that was cut off starts again from the beginning.
:::

:::details[Can't reach Markdrop]
Your connection to markdrop.in dropped. Check you're online and try again. On the sender's side, people already connected keep downloading while the page reconnects.
:::

:::details[The recipient's CLI is out of date]
An older CLI can only receive one file at a time. Ask them to update (`brew upgrade markdrop`), or send a single file.
:::

## Slow or stuck transfers

**Check the route.** While a file is moving, the page shows **Direct** or **Relayed**. A relayed transfer passes through an encrypted relay because the two networks couldn't reach each other, and it's usually slower than a direct one.

**Two devices on the same Wi-Fi can still be relayed.** Some networks, like office, hotel and café Wi-Fi, keep devices from talking to each other. Switching one device to mobile data often gives a direct route.

**Turn off VPNs** on both devices if you can. A VPN often hides the direct route.

**"This network is making it hard"** means connecting is taking longer than usual. It can take up to half a minute.

**"Waiting on the network…"** on the sender's page means data has stopped flowing for the moment. It continues on its own if the connection recovers.

## Large files and phones

There's no size limit, but a browser holds each incoming file in memory until it's saved. Very large files may not fit, especially on phones.

- On an iPhone, Markdrop warns you when the total is large: download a few files at a time.
- To receive something really large, use the [Markdrop CLI](/cli/send-and-receive). It writes straight to disk, so it has no size limit.

## Before you share

- **Keep the sender's tab open** and in the front on a phone. Closing or reloading it ends the share, and a reload starts a new link.
- **Send one link to everyone.** Up to 10 people can download at once, and each picks what they want.
