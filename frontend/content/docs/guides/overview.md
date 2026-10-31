---
title: Markdrop Guides
nav: Overview
description: Markdrop Guides builds and hosts help centers, product guides and API references. What it does, how it differs from the Markdrop docs, and where to start.
updated: 2026-10-31
keywords: [markdrop guides, guides, documentation site, help center, knowledge base, product guide, gitbook alternative, hosted docs, beta]
---

Markdrop Guides builds and hosts guides for your product: help centers, product guides, API references and handbooks. These pages explain how to use it. You write pages in the browser, pick a theme, and publish to an address like `acme.guides.markdrop.in`. Your readers get search, Ask AI and pages their AI tools can read.

:::note[Markdrop Guides or the Markdrop docs?]
The site you're reading, docs.markdrop.in, is the Markdrop docs: Markdrop's own documentation. It's built with the same engine, but it isn't a guide you manage. The pages in this **Markdrop Guides** tab are about the product at [markdrop.in/guides](https://markdrop.in/guides), where you make guides for *your* product. Everything else on this site is about Markdrop itself.
:::

Markdrop Guides is in beta, and free while it is.

![The Markdrop Guides home: Your guides, the last 7 days across them (live guides, readers, Ask AI answers, page feedback), the All, Live, In review and Drafts filters, and the Acme workspace's guides as cards: Acme (Live, with its views and how many found it helpful), Acme Help Center (In review, pages waiting for a reviewer) and Acme Developers (Draft, not published yet).](/docs-assets/guides/overview/studio-home.webp "The Markdrop Guides home: every guide you can open, each drawn in its own theme.")

## Your guides

The Markdrop Guides home lists every guide you can open, in your workspaces and your personal ones.

- **The last 7 days** across your guides: how many are live, readers (and the change from the week before), Ask AI answers (and how many it couldn't answer), and the share of page feedback that said a page helped. The numbers come from each guide's [Insights](/guides/insights). A guide with Insights off adds nothing, and a number that can't be counted yet shows as **—**.
- **Filters**: **All**, **Live**, **In review** (changes are waiting for a reviewer) and **Drafts** (never published), and **Workspace** to show one workspace or your personal guides. Switch between cards and a list with the buttons beside it; Markdrop remembers your choice in this browser.
- **Each guide** shows a small drawing of it in its own theme and colours, its state (**Live**, **In review**, **Draft**, **Building** while a publish runs, **Failed** when the last publish didn't go through), its address, its workspace, pages and last change. A live guide shows its views over the last 7 days and how many readers found it helpful. **Open editor** opens it, **View** opens the live guide, and **Preview** shows a draft's home page. **More** has the guide's Design, Publishes, Insights and Settings, and **Delete guide** for admins.
- **Search guides** in the header (**⌘K**, or **Ctrl K** on Windows) finds a guide by its name or address.

## What you can do

::::cards
:::card[Create a guide]{href="/guides/create-a-site" icon="plus"}
Start blank or from a template: a product guide, a help center, or an API reference generated from your OpenAPI file.
:::
:::card[Import from GitBook]{href="/guides/import-from-gitbook" icon="download"}
Bring pages, images, navigation and old links across from a public GitBook site.
:::
:::card[Write in the editor]{href="/guides/editor" icon="edit"}
A visual editor with a slash menu for callouts, steps, tabs and code, or plain Markdown.
:::
:::card[Pick a theme]{href="/guides/themes" icon="image"}
Six themes, your logo and colours, fonts, corners and custom CSS.
:::
:::card[Publish and review]{href="/guides/publishing" icon="send"}
Drafts stay private until you publish. Turn on reviews to have changes approved first.
:::
:::card[Give people roles]{href="/guides/members-and-roles" icon="users"}
Admin, Reviewer, Editor or Viewer, for the whole workspace or one guide.
:::
:::card[See how it's read]{href="/guides/insights" icon="chart"}
Views, searches with no results, Ask AI questions and page feedback. No cookies.
:::
::::

## How it works

1. **A guide lives in a workspace**, or is personal to you. Workspace guides are shared with the people who have a Guides role there. Workspaces themselves are Markdrop's: see [Create a workspace](/workspaces/create).
2. **Every page is a draft** until you publish. Drafts save as you type, and every save is a version you can go back to.
3. **Publishing builds the guide.** Readers keep seeing the last published version until the new one is live, a few seconds later. Every publish is numbered, and an admin can put an earlier one back.
4. **Readers get a fast static site** with search, an AI assistant that answers from your pages, a Markdown copy of every page and `llms.txt`. Add an OpenAPI file and they get an [API reference](/guides/api-reference) with Try it too. See [What readers get](/guides/what-readers-get).
5. **Insights shows how it's read**: page views, top pages, searches that found nothing, Ask AI questions and page feedback, without cookies or personal data. See [Insights for your guide](/guides/insights).

## Watch it once

::video{id="guides-first-guide" title="Create and publish your first guide" duration="0:56"}

## Before you start

You need a free Markdrop account: Markdrop Guides uses the same sign-in as the rest of Markdrop. See [Accounts](/get-started/accounts).

To create a guide in a workspace you need to be a Guides admin there. Workspace owners and admins always are. Anyone can create a personal guide.

## What isn't there yet

These are planned and marked **Coming soon** in the app:

- **Password-protected and members-only guides.** For now every published guide is public. See [Guide settings](/guides/site-settings#who-can-read-it).
- **GitHub sync.** See [GitHub sync](/guides/github-sync).

## Open Markdrop Guides

Go to [markdrop.in/guides](https://markdrop.in/guides). From inside Markdrop you can also get there from your account menu (**Guides**), from a workspace's **Guides** link in the sidebar, or with **Guide** in the create menu. Inside Markdrop Guides, **Documents** and **Files** in the header (or **Dashboard** in your account menu) go back to the rest of Markdrop.
