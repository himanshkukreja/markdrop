---
title: What gets counted
description: What a view is, whose views are left out, who is shown by name and who stays anonymous, and how long reading and watching data is kept.
updated: 2026-11-07
prerequisites: [/analytics/overview]
keywords: [privacy, views, people, unique visitors, owner views, members, bots, global privacy control, gpc, retention, ip address, k-anonymity, viewers, signed in, anonymous, location]
---

Analytics answers "is this working?" and, on the [Viewers](/analytics/viewers) tab, "who opened it and what did they do?". This page lists exactly what is counted, who is shown by name, what is left out, and what is never stored.

## Views and people

- **A view** is one time someone opens your link. Opening it again later is another view.
- **People** counts distinct visitors, worked out from a hashed IP address. Two people on the same network can count as one person, and one person on two networks as two.
- **Returning** people opened the link on at least two different days.

Each open also starts a reading or watching session, which records how far people got. A session is kept only once it has at least 2 seconds of active time, or the visitor played some media.

**Active time** counts a second only while the tab is visible and the reader did something in the last minute, or while media is playing. A tab left open in the background doesn't add time.

## Whose views are left out

- **Yours.** When you're signed in, your own views of your own links aren't counted in any number. They're kept apart on the **Viewers** tab, hidden until you turn off **Hide my own views**. If you open your link while signed out, Markdrop can't tell it's you, and the view counts.
- **Your workspace's members.** For an item in a workspace, views from its members are recorded as internal and hidden by default. On the item's **Audience** tab, turn off **Hide views from Acme members** to include them. The home board, live view and CSV downloads always leave them out.
- **Bots and crawlers.** Requests that identify as bots, crawlers or scripts aren't counted.
- **Link previews.** When Slack, LinkedIn, WhatsApp or another app fetches your link to show a preview, it's counted under **Share signals**, not as a view.

![The Audience tab of a workspace document with the Hide views from Acme members switch on and a note of how many member views are hidden, above New and returning, Devices and Countries.](/docs-assets/analytics/what-gets-counted/audience-internal-toggle.webp)

## Global Privacy Control

If a visitor's browser sends [Global Privacy Control](https://globalprivacycontrol.org/), Markdrop sends no reading or watching data for them at all. Their visit still counts as a view, but without where they came from.

## What you see, and what you don't

The **Overview**, **Audience** and other tabs show totals and patterns:

- **Countries** with fewer than 5 people are grouped as **Other**. **Campaigns** are grouped the same way.
- Live view shows only countries and device types, never who someone is.
- Devices are coarse, like "phone" and the browser's name.

The [Viewers](/analytics/viewers) tab lists each view:

- **Signed-in viewers** by name and email address, with what they did.
- **Everyone else** as an anonymous **Visitor** with a short code from a random id in their browser. Never their name, email or IP address. Their location is shown to city level at most.
- Each view's city, device, operating system and browser with versions, and source.

Only the owner sees this, and for an item in a workspace its admins and editors. The workspace's viewers see the number of views only.

## What is never stored

- **Raw IP addresses.** Markdrop stores a salted hash of the IP address, never the address itself.
- **Copied text.** For a code block, Markdrop counts that it was copied and which block it was, using a hash of the block. What readers copy is never stored. Other text selections aren't tracked.
- **Anything typed**, and the query strings or fragments of links people click. For clicked links, only the host and path are kept.
- **Content of encrypted documents.** For an [end-to-end encrypted](/sharing/end-to-end-encryption) document, only time and how far people scrolled are recorded.

Markdrop looks up an approximate location from the IP address when a view comes in. It stores the country, region and city with the view. The Audience tab shows countries; the Viewers tab shows each view's city, region and country.

## How long it's kept

| Data | Kept for |
| --- | --- |
| Reading and watching sessions (time, depth, sections, pages, playback) | 395 days, then deleted |
| Each view's detail on the Viewers tab (who, where from, on what, the timeline) | 180 days, then deleted |
| Live presence | About 45 seconds after a visitor's last signal; never saved |
| View records | No fixed deletion date |

## Related

::::cards
:::card[Privacy at Markdrop]{href="/security/privacy" icon="eye"}
What Markdrop collects across the whole product.
:::
:::card[Documents and PDFs]{href="/analytics/documents-and-pdfs" icon="doc"}
How reading depth and pages are measured.
:::
::::
