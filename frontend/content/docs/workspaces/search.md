---
title: Search
description: Find anything you can open with ⌘K. Search reads titles, headings, text and file contents, forgives typos, and answers questions with AI.
updated: 2026-11-04
keywords: [search, find, command k, cmd k, ctrl k, fuzzy, typo, global search, ask ai, ai search, question, trash, filters, workspace search, pdf text, html text]
---

Press :kbd[⌘K] (:kbd[Ctrl+K] on Windows and Linux), or select the search field at the top of the app, and start typing. Search looks through everything you can open, wherever it lives, and shows results as you type.

## What search covers

- **Your own pages, documents and files**, private ones included.
- **Your workspaces**: everything each workspace lets you open, by its rules. See [Privacy](/workspaces/privacy) and [Members and roles](/workspaces/members-and-roles).
- **What's shared with you** by email, and the sub-pages below a shared page.
- **Folders and workspaces** you're a member of.
- **Guides pages** of the [Guides](/guides/overview) you have a role on.
- **Your Trash.** Matches show at the bottom, marked **In Trash**, with a **Restore** button. You see the same items as on the [Trash](/documents/trash) page.

Search never shows anything you can't open. Every result is checked against your access when you search, so a removed share or a document made private drops out at once. Other people's public links aren't searched: search is for your own things.

## How matching works

- **Typos and half-remembered names.** `onbording plyabook` finds **Onboarding Playbook**.
- **Partial words.** Results update as you type, so `onboa` already finds it.
- **Any word order.** `playbook onboarding` works too.
- **Inside the text.** Search reads headings and the first 20,000 characters of a page's text. In files, it reads the text of HTML pages, PDFs and text files (the first 50,000 characters, read in the background shortly after upload). Other files match by name.
- **Section links.** When the words match a heading, the result opens at that section.
- **Where you are first.** The workspace you're in ranks a little higher. Recent changes and your own items do too.

Password-protected and [end-to-end encrypted](/sharing/end-to-end-encryption) documents match by title only. Their text is never searched and never shown in a snippet. An encrypted document's title is encrypted too, so it matches by its link.

## Filters and keys

The chips under the search field narrow results to **Pages**, **Documents**, **Files**, **Folders** or **Guides**. Inside a workspace, a chip limits the search to that workspace.

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

The answer streams in above the results, with its sources listed under it. AI can be wrong, so check the sources.

:::note[What is sent to AI]
AI search uses Claude Haiku 5.5 from Anthropic. Only the matching excerpts of items you can open are sent, never anything else. Encrypted items are never sent, a password-protected item is sent by its title only, and nothing is sent from a workspace whose admin turned [AI features](/pages/ai#turn-ai-off-for-a-workspace) off. Markdrop keeps the usage counts, not the text. See the [privacy policy](https://markdrop.in/privacy#processors).
:::

AI search needs an account and counts towards your AI limits. When a limit is reached, search still works and the card says when AI will be back.

## Search from an AI app

The hosted MCP server's `search` tool uses the same search, and `ask_documents` asks a question the same way Ask AI does. See [MCP tools](/ai/tools#read-and-find).
