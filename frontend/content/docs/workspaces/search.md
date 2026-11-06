---
title: Search
description: Find anything you can open with ⌘K. Search reads titles, headings, text and file contents, forgives typos, and answers questions with AI.
updated: 2026-11-06
keywords: [search, find, command k, cmd k, ctrl k, fuzzy, typo, global search, ask ai, ai search, question, trash, filters, workspace search, search this workspace, only this workspace, recent searches, recently opened, meetings, transcript, whole transcript, pdf text, html text, word, docx, excel, xlsx, csv, captions, video captions, page number, slack, /markdrop search, search log]
---

Press :kbd[⌘K] (:kbd[Ctrl+K] on Windows and Linux), or select the search field at the top of the app, and start typing. Search looks through everything you can open, wherever it lives, and shows results as you type.

## What search covers

- **Your own pages, documents and files**, private ones included.
- **Your workspaces**: everything each workspace lets you open, by its rules. See [Privacy](/workspaces/privacy) and [Members and roles](/workspaces/members-and-roles).
- **What's shared with you** by email, and the sub-pages below a shared page.
- **Folders and workspaces** you're a member of.
- **Guides pages** of the [Guides](/guides/overview) you have a role on.
- **Meetings.** A [meeting](/workspaces/meetings) is a page, so its notes are searched like any page. Words said in its transcript find the meeting's page, not the transcript on its own.
- **Your Trash.** Matches show at the bottom, marked **In Trash**, with a **Restore** button. You see the same items as on the [Trash](/documents/trash) page.

Search never shows anything you can't open. Every result is checked against your access when you search, so a removed share or a document made private drops out at once. Other people's public links aren't searched: search is for your own things.

## How matching works

- **Typos and half-remembered names.** `onbording plyabook` finds **Onboarding Playbook**.
- **Partial words.** Results update as you type, so `onboa` already finds it.
- **Any word order.** `playbook onboarding` works too.
- **Inside the text.** Search reads headings and the text of pages and documents. Meeting transcripts are read in full, every minute of them (up to about three and a half hours per meeting), and a match shows the moment it was said. In files, it reads Word documents (`.docx`), Excel workbooks (`.xlsx`, each sheet's first 200 rows), CSV files, PDFs page by page, HTML pages and text, Markdown and JSON files, up to 200,000 characters each, read in the background shortly after upload. A video is read through its [captions](/files/video-and-audio#captions) and the text around it on pages that embed it. Other files match by name.
- **Where in the file.** A match deep in a file shows where it is (**Page 3 ·**, **Sheet Budget ·**, **12:34 ·**) and opens there: a PDF at that page, a video playing from that moment.
- **Section links.** When the words match a heading, the result opens at that section.
- **Where you are first.** The workspace you're in ranks a little higher. Recent changes and your own items do too.

Password-protected and [end-to-end encrypted](/sharing/end-to-end-encryption) documents match by title only. Their text is never searched and never shown in a snippet. An encrypted document's title is encrypted too, so it matches by its link.

## Filters and keys

Before you type, search shows your **Recent searches** and **Recently opened** items. **Clear recent searches** forgets the searches.

The chips under the search field narrow results to **Pages**, **Documents**, **Files**, **Folders** or **Guides**; **All** shows every kind again.

### Search one workspace

Inside a workspace, the workspace you're in ranks a little higher, and one more chip, **Only Acme** (with your workspace's name), searches only that workspace. Select it and the field says "Search Acme, or ask a question"; select it again to search everywhere. **Ask AI** then answers from that workspace too.

| Key | What it does |
|---|---|
| :kbd[↑] :kbd[↓] | Move through results |
| :kbd[Enter] | Open the result |
| :kbd[Shift+Enter] | Open it in a new tab |
| :kbd[⌘Enter] | Ask AI |
| :kbd[Tab] | Move to the filters |
| :kbd[Esc] | Close |

**See all results** opens the search page, with filters for the kind, the workspace, the owner and when it was last updated, and **Load more** for long lists. In **My files**, type in the search field and press :kbd[Enter] to search everywhere.

## Ask AI

Type a question, like `how do we onboard contractors?`, or select **Ask AI ✦**. Search also asks on its own when what you type reads like a question or a description.

1. AI turns your question into search terms.
2. Search finds up to 40 items you can open that match them.
3. AI reads their titles and short excerpts, picks the relevant ones and writes a short answer. Each claim cites its source as a number you can select.

The answer streams in above the results, with its sources listed under it. AI can be wrong, so check the sources. An answer is never blank: if it runs long, you get what was written and a note that it was cut short.

:::note[What is sent to AI]
AI search uses Claude Haiku 5.5 from Anthropic. Only the matching excerpts of items you can open are sent, never anything else. Encrypted items are never sent, a password-protected item is sent by its title only, and nothing is sent from a workspace whose admin turned [AI features](/pages/ai#turn-ai-off-for-a-workspace) off. Markdrop keeps the usage counts, not the text. See the [privacy policy](https://markdrop.in/privacy#processors).
:::

AI search needs an account and counts towards your AI limits. When a limit is reached, search still works and the card says when AI will be back.

For a conversation, with follow-ups, meeting transcripts and ready-made questions like **Catch me up on this week**, use [Ask](/workspaces/ask-markdrop) at the top of your home.

## Search from an AI app

The hosted MCP server's `search` tool uses the same search, and `ask_documents` asks a question the way [Ask](/workspaces/ask-markdrop) does, follow-ups included. See [MCP tools](/ai/tools#read-and-find).

## What searching a workspace records

To show workspace admins what people [couldn't find](/analytics/content-gaps), Markdrop keeps the words searched inside a workspace, without who searched: no account and no IP address. Searches in your own files outside a workspace aren't kept, and neither are searches that look like an email address or a long number. Records are deleted after 90 days. See [Privacy at Markdrop](/security/privacy#what-searching-a-workspace-records).

## Search from Slack

With [Markdrop for Slack](/integrations/slack), `/markdrop search onboarding` finds what you can open, and only you see the results. `/markdrop ask` answers a question.

## Search from the terminal or the API

`markdrop search` in the [CLI](/cli/search-trash-access#search) uses the same search, with `--kind` and `--workspace` filters and the matching text for each result.

With an [API token](/cli/login-and-tokens), `GET /api/v1/search?q=…` returns the same results as JSON: each one's kind, title, workspace and folder, a snippet with the matched words marked, and `web_url`, a full link to open it. `scope=workspace:<id>`, `kind`, `owner=me` and `updated=week|month` narrow it, and `next_cursor` pages through the rest. See [Search everything](/api/search/search-everything) in the API reference.
