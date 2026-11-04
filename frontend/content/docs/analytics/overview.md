---
title: Analytics overview
description: See how people read, watch and share what you publish. Every link you own, in one place, with your own views left out.
updated: 2026-11-05
keywords: [analytics, stats, views, dashboard, insights, csv, metrics, ai insights, ask your analytics, what changed]
---

Analytics shows what happens after you share a link: how many people opened it, how far they read, where they stopped watching, and where they came from. You see totals and patterns, never who someone is.

Open **Analytics** in the sidebar, or go to [markdrop.in/dashboard/analytics](https://markdrop.in/dashboard/analytics). You need to be signed in, and you see analytics only for things you own.

::video{id="series-07-creator-analytics" title="See how far people read and watch what you share" duration="1:28"}

## The home board

The home board covers everything you've published.

| Tile | What it counts |
| --- | --- |
| **Views** | Times your links were opened, across all of them. |
| **People** | Distinct visitors. |
| **Watch time** | Time spent playing your videos and audio. |
| **Read to the end** | Share of reading sessions on documents and PDFs that reached the end. |

Below the tiles:

- **Your links** lists each link with its views, a trend line, how engaged people were, and the last view. A green dot means someone is on it now.
- **Insights** (marked with ✦) says what changed in the period and why. See [Insights and Ask](#insights-and-ask).
- **Worth a look** points out things that stand out, like where people stop watching. Insights appear once your links have about 20 visits.
- **Write this next** appears if you own or run a workspace, or have your own Guides. See [What people couldn't find](/analytics/content-gaps).

![The Analytics home board: tiles for Views, People, Watch time and Read to the end, each compared with the previous 30 days, the Your links table with views, trend lines, engagement and last view, and Worth a look on the right.](/docs-assets/analytics/overview/analytics-home.webp)

Choose the period with the range picker: **7 days**, **30 days** (the default), **90 days** or **All time**. Each number is compared with the period of the same length right before it, like "+12% vs previous 30 days". Days run in UTC.

Choose **CSV** to download the numbers for the period.

## One link in detail

Choose a link in **Your links** to open its own page. You can also open the menu on any item you own and choose **Analytics**.

The tabs depend on what the link is:

| Kind | Tabs |
| --- | --- |
| Document | **Overview**, **Content**, **Audience** |
| PDF | **Overview**, **Pages**, **Audience** |
| Video | **Overview**, **Video**, **Audience** |
| Audio | **Overview**, **Listening**, **Audience** |
| Other files | **Overview**, **Audience** |

Files you've replaced with a new version also get a **Versions** tab that compares them.

- **Overview** has the headline numbers for that kind, **Views per day**, **Where views come from**, and **What stands out**.
- **Audience** shows **New and returning** visitors, **Devices**, **Countries**, **Channels**, **Share signals** (times an app showed a preview of your link) and **Campaigns**.

![The analytics page for the Getting started with Acme document: tabs Overview, Content and Audience; tiles for Views, People, Read to the end, Median read time and Copies & link clicks; What stands out; Views per day; and Where views come from.](/docs-assets/analytics/overview/link-analytics-overview.webp)

The other tabs are covered in [Documents and PDFs](/analytics/documents-and-pdfs) and [Video and audio](/analytics/video-and-audio). At the top of the **Content**, **Pages**, **Video**, **Listening** and **Versions** tabs, **✦ Insights** asks AI why people stop and what to change: see [AI insights for one link](/analytics/ai-insights).

## Insights and Ask

**Insights** sums up the period in 3 to 5 sentences: what changed compared with the period before, and the likely reason, like a link that took off, a site that sent more people, a new version of a file, or a shift in devices or countries. Each sentence links to where you can look closer. Choose **7 days**, **30 days** or **90 days** to change the period (**All time** shows the last 30 days).

The summary is written once a day and kept; choose **Refresh** to write it again. It appears once your links have about 20 views between this period and the one before.

Under it, type a question in **Ask your analytics**, like "Which link did best this month?" or "Where did Tuesday's spike come from?". The answer streams in and links to the analytics pages it used. If your question isn't something Markdrop measures, it says so.

Both use Claude Haiku 5.5. What it gets:

- Totals and changes for your own links: views, people, read to the end, watch time.
- Your links' titles and kinds, the sites that sent people (the site name only, never the full address), channels, devices, versions of your files, and countries with at least 5 people (smaller ones are grouped as Other).

It never gets who visited: no IP address, no visitor or session id, no email. For **Ask**, the AI can't query your data directly. It picks from a fixed list of questions Markdrop knows how to answer, and Markdrop runs them on your own links only.

AI can be wrong. Check the linked page before you act on a number. Insights and Ask count towards your AI limits, and an admin can turn them off. When they're off, the card doesn't show.

## Ask your AI assistant

If you've connected an AI assistant to Markdrop, it can read these numbers too, and use `analytics_story`, `ask_analytics` and `content_gaps`. For example: "Where do readers drop off in my getting-started guide? Rewrite that section." See [AI tools](/ai/tools).

## Next

::::cards
:::card[What gets counted]{href="/analytics/what-gets-counted" icon="eye"}
What a view is, whose views are left out, and what's never stored.
:::
:::card[Live now]{href="/analytics/live" icon="wave"}
See who's reading or watching right now.
:::
::::
