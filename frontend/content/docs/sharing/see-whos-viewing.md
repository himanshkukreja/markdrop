---
title: See who's viewing
description: Avatars on a document or file show who has it open right now and where they're reading. People with access appear by name; everyone else as an anonymous animal.
updated: 2026-11-03
prerequisites: [/sharing/who-can-open]
keywords: [presence, who's viewing, live, avatars, anonymous, viewers, readers, online, Anonymous Otter, mcp, get_viewers, set_presence, ai]
---

When other people have the same document or file open, their avatars appear at the top of the page, next to **Copy link**. Choose the avatars to see the list: everyone who's viewing and the section each of them is reading.

Presence is live and lives only in memory: nothing about who viewed is stored, and it never appears in your analytics.

## What you see

| On the page | What it means |
| --- | --- |
| An avatar with a coloured ring | Someone has the page open. Hover it to see their name and section. |
| A faded avatar with an amber dot | They're away: the tab is open but hidden. |
| **+3** | Three more people than fit in the row. |
| Your own avatar, last in the row | You. In the list you come first, marked **(you)**. |
| Small coloured dots beside a heading | Someone in that colour is reading that section. The dots sit in the **Contents** list, or in the margin when Contents isn't on screen. |

On a PDF the list says which page each person is on, and on a video, roughly where they are. Readers in full screen see the avatars in the corner, beside **Show details**, whenever someone else is there too.

On phones the row is shorter, and the list opens as a sheet.

## Who appears by name

You appear by name and photo only to people viewing a document you have a real relationship with:

- you own it;
- you're a member of the workspace it's in, with a role that can open it;
- it was shared with you by email.

Everyone else appears as an anonymous animal, like **Anonymous Otter** or **Anonymous Fox**, with its own colour. That includes people who are signed in but have none of those relationships: someone who opened a public link while signed in is still anonymous. No name, email address or photo of an anonymous viewer is ever sent to anyone.

Your animal stays the same while the tab stays open, even if your connection drops and comes back. Another tab, or another document, gets another animal.

:::note
Markdrop decides who appears by name on its servers, from the document's access settings, every time someone joins and again about every minute after. When someone takes away your access to the document, you leave the list at once. If you're removed from its workspace but can still open it by its link, you turn anonymous within a minute or two.
:::

## Show me as anonymous

Signed in and would rather not be named? Choose the avatars, then turn on **Show me as anonymous**. Others see an animal instead of your name, on every document, until you turn it off. The choice is remembered in this browser.

## Turn it off for a document

If you own a document or file, you choose whether it shows who's viewing.

::::steps
### Open Share
On the document, choose **Share**. On a file, open **More** and choose **Share**.

### Turn off Show who's viewing
It's under **People with access**. It's on by default.
::::

With it off, nobody on that document sees any avatars, and the pages stop reporting where anyone is reading. Turning it back on shows everyone at once.

## Encrypted documents

On an [end-to-end encrypted](/sharing/end-to-end-encryption) document you only see how many people have it open, for example "3 viewing". Never names, and never sections: the headings are part of the encrypted text, which Markdrop's servers never see.

## Ask your AI app who's viewing

With Markdrop [connected to your AI app](/ai/hosted-mcp), ask "Who's reading the launch notes right now?" and it answers with the same list the page shows: names for the people with a relationship to the document, an anonymous animal for everyone else, where each one is reading and who's away. It works for any document you can open, and asking doesn't put you on the list.

The rules don't change: no email addresses, only the count on an encrypted document, and "presence is off" when the owner has turned it off. As the owner, you can also say "Turn off who's viewing on the Q3 report." The tools are `get_viewers` and `set_presence` in [MCP tools](/ai/tools#whos-viewing).

## Privacy

- Presence is held in memory while people have the page open, then forgotten. It's never logged, stored or added to analytics.
- Your section is reported at most every couple of seconds, and only as the heading you're in, the page number or the rough time in a video: never what you select or type.
- Session recordings never include the avatars, names or the list.

See also the [privacy policy](https://markdrop.in/privacy).
