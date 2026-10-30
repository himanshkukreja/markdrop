---
title: Video and audio
description: Share screen recordings and audio up to 2 GB at a link that streams in any browser, with speed control, keyboard shortcuts and a poster frame.
updated: 2026-10-30
keywords: [video, audio, mp4, mov, webm, mp3, player, screen recording, codec, playback speed]
---

Send a link instead of a 900 MB attachment. Upload a screen recording or a voice memo and readers press play in their browser: it streams, seeks instantly, and never asks them to download the whole file.

::video{id="video-player" title="Share a screen recording" duration="0:40"}

## What you can upload

| Kind | Extensions | Size limit |
| --- | --- | --- |
| Video | `.mp4`, `.mov`, `.webm`, `.ogv` | 2 GB |
| Audio | `.mp3`, `.m4a`, `.wav`, `.ogg` | 2 GB |

Upload at [markdrop.in/upload](https://markdrop.in/upload), or with `markdrop upload demo.mp4` from the terminal, which resumes if the connection drops. See [Upload large files](/files/large-uploads).

Markdrop doesn't convert your file. Readers get exactly the bytes you uploaded, so what plays depends on how the file was encoded. **H.264 MP4** plays in every current browser; it's the safe choice.

## The video player

Markdrop's player looks and works the same in every browser. It has play and pause, a scrubber that shows what has loaded, back and forward 10 seconds, volume, playback speed from 0.25× to 2×, picture in picture where the browser supports it, and full screen.

### Keyboard shortcuts

Click the video first, then:

| Key | Does |
| --- | --- |
| :kbd[Space] or :kbd[K] | Play or pause |
| :kbd[←] / :kbd[→] | Back or forward 5 seconds |
| :kbd[J] / :kbd[L] | Back or forward 10 seconds |
| :kbd[↑] / :kbd[↓] | Volume up or down |
| :kbd[M] | Mute |
| :kbd[F] | Full screen |
| :kbd[,] / :kbd[.] | Back or forward one frame, while paused |
| :kbd[0] to :kbd[9] | Jump to 0% to 90% of the way through |

## Poster frames and details

After an upload, Markdrop reads the video's length, resolution and codecs, and takes a poster frame for the player and the link preview. If it can't read the file, the video still publishes and plays, without a poster.

`markdrop info demo-clip` shows what Markdrop found:

```text
https://markdrop.in/demo-clip
  slug      demo-clip
  type      video/mp4
  size      412.6 MB
  version   1
  media     2560×1440 · 4m12.3s · h264/aac
```

(Trimmed: it also prints the SHA-256, dates and the poster's address.)

## Audio

Audio plays in the browser's own audio player, centred on the page. It streams and seeks the same way video does.

## When a video won't play

The player tells you which of three things went wrong:

| Message | What it means | What to do |
| --- | --- | --- |
| "This video can't be played here." | The browser can't decode the codec inside the file. This is common with `.mov` recordings. | **Download** it to play locally, or re-encode it as H.264 MP4 and [replace the file](/files/replace-and-versions). |
| "You don't have access to this video." | The video is protected and the reader isn't signed in with an address it was shared with. | Open it from its Markdrop page while signed in. See [Who can open what](/sharing/who-can-open). |
| "This video is no longer available." | The file was deleted or has expired. | Ask whoever shared it for a new link. |

## Private videos

A video set to **Only people added**, a workspace team, or a password plays through a signed link that lasts 4 hours, long enough to watch a long recording without interruption. If you narrow who can open it, by making it private or adding a password, links already handed out stop working straight away.

## See who watched

Signed in, the file's analytics show how far people watched, second by second, which parts they rewatched or skipped, and whether any plays failed. See [Video and audio analytics](/analytics/video-and-audio).

## Related

- [Upload large files](/files/large-uploads)
- [Replace a file and restore versions](/files/replace-and-versions)
- [Link previews](/documents/link-previews)
