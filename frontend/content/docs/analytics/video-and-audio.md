---
title: Video and audio analytics
description: See who's still watching second by second, what people rewatch and skip, and whether your video actually played well.
updated: 2026-10-30
prerequisites: [/analytics/overview, /analytics/what-gets-counted]
keywords: [video analytics, audio, retention, watch time, drop-off, rewatch, playback, buffering, quality]
---

For a video or audio file, analytics shows how much of it people watched or listened to, where they stopped, and whether playback worked. Open the file's analytics page from [Analytics](https://markdrop.in/dashboard/analytics). Audio uses the same views, with "listen" in place of "watch".

## Overview

| Number | What it means |
| --- | --- |
| **Views** and **People** | Times it was opened, and distinct visitors. |
| **Watch time** | Total time played, across everyone. |
| **Avg watched** | On average, how much of the video each person who pressed play watched. |
| **Played** | Share of visits where someone pressed play. |

Markdrop counts the parts of the file someone actually played. Watching the same minute twice still covers that minute once, and skipping ahead doesn't count what was skipped. Someone counts as having finished when playback reaches the end or they've watched at least 90% of it.

::clip{src="/docs-assets/analytics/video-and-audio/analytics-retention" alt="Animation: three viewers' played ranges, one rewatching and one skipping, merge into a 'still watching' curve that draws left to right with a marker where most viewers leave." theme="light"}

## Video tab

The **Video** tab (**Listening** for audio) goes second by second.

### Who's still watching, second by second

A curve of how many people who pressed play were still watching at each point. Markdrop marks moments worth a look under it, such as:

- how many people are still watching at 0:30,
- where most viewers leave, and
- the part that's replayed most.

![The Who's still watching, second by second chart for Product demo, with notes under it: 43% still watching at 0:30, Most viewers leave at 0:13 and Replayed most at 0:16, and the Rewatched and skipped strip.](/docs-assets/analytics/video-and-audio/retention-curve.webp)

### Rewatched and skipped

A strip across the length of the video: darker means more rewatching, and gaps mean parts people skipped.

### How they watch

Playback speeds people use, like 1.5×, and how many go fullscreen, watch muted, or use picture-in-picture.

### Could people actually watch it?

For video, Markdrop checks whether playback went well, and labels it **Plays smoothly**, **Slow starts on phones** or **Plays failing**.

| Tile | What it means |
| --- | --- |
| **Time to start (typical)** | How long the typical viewer waited for playback to start. The note shows the slowest 5%. |
| **Sessions that stalled** | Viewers who waited for the video to load mid-play. |
| **Plays that failed** | Plays that didn't work, and why. |
| **Phone viewers waiting > 5 s** | Phone viewers who waited more than 5 seconds to start, with the countries most affected. |

When there's a clear fix, a **Suggestion** tells you what to change.

![The Could people actually watch it? panel labelled Slow starts on phones, with tiles for Time to start (typical), Sessions that stalled, Plays that failed and Phone viewers waiting > 5 s, and a Suggestion below.](/docs-assets/analytics/video-and-audio/playback-health.webp)

## Versions

When you [replace a file](/files/replace-and-versions) with a new version, each version keeps its own numbers. Pick a version on the Video tab to see its curve. The **Versions** tab lists **Every version** with when it went live, its views and sessions, and **Avg watched**. For video, it also compares the first minute of the current and previous version.

The Versions tab always covers each version's whole life, whatever range you picked.

## Watch it once

::video{id="video-analytics" title="Find where viewers drop off" duration="0:45"}
