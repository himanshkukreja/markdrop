---
title: Markdrop Guides
nav: Overview
description: Markdrop Guides builds and hosts docs that show you what to fix next. What it is, the Fix list, what every guide gets and where to start.
updated: 2026-11-02
keywords: [markdrop guides, guides, documentation site, help center, knowledge base, product guide, docs platform, gitbook alternative, mintlify alternative, hosted docs, fix list, beta, guides.markdrop.in]
---

::video{id="guides-trailer" title="Markdrop Guides in two minutes" duration="2:29"}

**Docs that show you what to fix next.** Markdrop Guides builds and hosts docs for your product: help centers, product guides, API references and handbooks. You write in the browser (or sync from GitHub), pick a theme and publish to an address like `acme.guides.markdrop.in` or your own domain. Then the **Fix list** tells you, from what readers and AI agents actually run into, which page to fix first, and drafts the fix.

- **Open the studio:** [guides.markdrop.in](https://guides.markdrop.in), with your Markdrop account.
- **What it is, how it compares, and pricing:** [markdrop.in/guides](https://markdrop.in/guides). It's free while it's in beta, with every feature.

:::note[Markdrop Guides or the Markdrop docs?]
The site you're reading, docs.markdrop.in, is the Markdrop docs: Markdrop's own documentation. It's built with the same engine, but it isn't a guide you manage. The pages in this **Markdrop Guides** tab are about the product at [markdrop.in/guides](https://markdrop.in/guides): you make guides for *your* product at [guides.markdrop.in](https://guides.markdrop.in). Everything else on this site is about Markdrop itself.
:::

## The Fix list: what to fix next

Every guide watches how it's read and turns it into one ranked list: the section where readers give up, the search that finds nothing, the question Ask AI couldn't answer, the page marked not helpful, the moment a video loses its viewers, the broken link, the page agents can't use. Each item shows its evidence and how many readers it affects, and **Draft a fix** proposes the edit for you to review in the editor. It counts nothing about readers as people: no cookies, no personal data.

![Acme's Fix list: 15 to fix, 2 high impact, 1 in progress and 1 fixed, 1,464 agent reads next to 1,059 readers. The top items: readers leave at "Install the CLI" (131 readers), Quickstart marked not helpful, API keys not updated in 8 months, Product tour loses most viewers at 0:40, and a page agents can't use.](/docs-assets/guides/fix-list/fixlist-overview.webp)

See [Fix list: what to fix next](/guides/fix-list), and [Insights](/guides/insights) for the numbers behind it.

## Every guide gets

::::cards
:::card[Private pages, free]{href="/guides/private-pages" icon="lock"}
Keep a guide public and make pages, groups or sections private: for your team, one customer's people, or partners with a password.
:::
:::card[Live demos, video and PDFs]{href="/guides/embed-files" icon="layers"}
Embed an interactive HTML demo, a PDF or a video from Markdrop, sandboxed on a separate domain, with a text version for search and AI.
:::
:::card[GitHub sync and imports]{href="/guides/import-from-github" icon="github"}
Keep docs in a repository and every push updates the guide. Or import from GitBook, Mintlify, Docusaurus or MkDocs.
:::
:::card[Ready for AI]{href="/guides/ai-ready" icon="zap"}
Ask AI for your readers, and Markdown pages, llms.txt and an MCP server for their assistants, with agent reads counted apart.
:::
::::

Plus your own domain with one-click DNS, fourteen themes and a theme builder, an API reference with Try it, a changelog with feeds, reviews and roles for your team, and light and dark for readers.

## Find your way around

These pages follow the order you'll need them in.

| Section | Pages |
| --- | --- |
| **Start** | [Create a guide](/guides/create-a-site), [Import from GitBook](/guides/import-from-gitbook), [Import from GitHub](/guides/import-from-github), [API reference from OpenAPI](/guides/api-reference) |
| **Write** | [The editor](/guides/editor), [Embed files](/guides/embed-files), [Pages and navigation](/guides/pages-and-navigation), [Changelog](/guides/changelog), [History](/guides/history) |
| **Look** | [Themes, the theme builder and resetting a design](/guides/themes), [Brand and style](/guides/brand-and-style) |
| **Publish and share** | [Publishing](/guides/publishing), [Reviews](/guides/reviews), [Your own domain](/guides/custom-domain), [Private pages](/guides/private-pages), [What readers get](/guides/what-readers-get) |
| **Improve** | [Fix list](/guides/fix-list), [Insights](/guides/insights) |
| **For AI** | [Ask AI](/guides/ask-ai), [llms.txt, MCP and agents](/guides/ai-ready) |
| **Reference** | [Guide settings](/guides/site-settings), [Members and roles](/guides/members-and-roles), [Limits](/guides/limits), [Self-hosting](/guides/self-hosting), [FAQ and troubleshooting](/guides/faq) |

## How it works

1. **A guide lives in a workspace**, or is personal to you. Workspace guides are shared with the people who have a Guides role there. Workspaces themselves are Markdrop's: see [Create a workspace](/workspaces/create).
2. **Every page is a draft** until you publish. Drafts save as you type, and every save is a version you can go back to. With [GitHub sync](/guides/import-from-github), a push updates the drafts (or publishes).
3. **Publishing builds the guide.** Readers keep seeing the last published version until the new one is live, a few seconds later. Every publish is numbered, and an admin can put an earlier one back.
4. **Readers get a fast static site** with search, light and dark, an AI assistant that answers from your pages, a Markdown copy of every page and `llms.txt`. Write [changelog entries](/guides/changelog) and they get a changelog with feeds too. Add an OpenAPI file and they get an [API reference](/guides/api-reference) with Try it. See [What readers get](/guides/what-readers-get).
5. **The Fix list and Insights show how it's read**: where readers leave, what they search for and ask, what they think of each page, and what AI agents read, without cookies or personal data.

## Open Markdrop Guides

The studio, where you make and manage guides, is at [guides.markdrop.in](https://guides.markdrop.in). It uses your Markdrop account: if you're signed in on markdrop.in, you're signed in there too, with no second sign-in; if not, Markdrop asks you to sign in first and brings you back. From inside Markdrop you can also get there from your account menu (**Guides**), from a workspace's **Guides** link in the sidebar, with **Guide** in the create menu, and with **Open your guides** on [markdrop.in/guides](https://markdrop.in/guides) when you're signed in. Inside Markdrop Guides, **Documents** and **Files** in the header (or **Dashboard** in your account menu) go back to the rest of Markdrop.

**Sign out** in Markdrop Guides signs you out of guides.markdrop.in, then asks whether to sign out of Markdrop too. Signing out on markdrop.in signs you out of both. Old links to markdrop.in/guides/… (in emails or bookmarks) still work: they open the same screen on guides.markdrop.in.

You need a free Markdrop account: see [Accounts](/get-started/accounts). Anyone can create a personal guide; to create one in a workspace you need to be a Guides admin there (workspace owners and admins always are).

## Your guides

The Markdrop Guides home lists every guide you can open, in your workspaces and your personal ones.

![The Markdrop Guides home: the last 7 days across your guides (2 of 3 live, 812 readers, 20 Ask AI answers with 13 unanswered, 80% found it helpful), the All, Live, In review and Drafts filters, and the Acme workspace's guides as cards: Acme (Live, 971 views, 80% found it helpful, 14 to fix), Acme Help Center (In review, 2 pages waiting for a reviewer) and Acme Developers (Draft, not published yet), then Start a new guide with Blank, Template, GitBook, GitHub and OpenAPI](/docs-assets/guides/overview/studio-home.webp "The Markdrop Guides home: every guide you can open, each drawn in its own theme.")

- **The last 7 days** across your guides: how many are live, readers (and the change from the week before), Ask AI answers (and how many it couldn't answer), and the share of page feedback that said a page helped. The numbers come from each guide's [Insights](/guides/insights). A guide with Insights off adds nothing, and a number that can't be counted yet shows as **—**.
- **Filters**: **All**, **Live**, **In review** (changes are waiting for a reviewer) and **Drafts** (never published), and **Workspace** to show one workspace or your personal guides. Switch between cards and a list with the buttons beside it; Markdrop remembers your choice in this browser.
- **Each guide** shows a small drawing of it in its own theme and colours, its state (**Live**, **In review**, **Draft**, **Building** while a publish runs, **Failed** when the last publish didn't go through), its address, its workspace, pages and last change. A live guide shows its views over the last 7 days, how many readers found it helpful, and how many things its [Fix list](/guides/fix-list) has for you (**14 to fix**). **Open editor** opens it, **View** opens the live guide, and **Preview** shows a draft's home page. **More** has the guide's Design, Publish, Fix list, Insights and Settings, and **Delete guide** for admins.
- **Start a new guide**, after your guides: **Blank**, **Template**, **GitBook**, **GitHub** or **OpenAPI**. See [Create a guide](/guides/create-a-site).
- **Search guides** in the header (**⌘K**, or **Ctrl K** on Windows) finds a guide by its name or address.

Inside a guide, its name in the header opens the guide switcher: every guide in that workspace with its logo (or its initial in its colour) and your role on it, then **All guides**, **New guide** and the workspace's Guides members. The bar under it has the guide's tabs: **Pages** (the editor), **Fix list**, **Changelog**, **Design**, **Publish**, **Insights** and **Settings**.

![The guide switcher open on Acme: the Acme workspace's guides Acme, Acme Help Center and Acme Developers, each with its logo or initial and the role Admin, then All guides, New guide and Members of Acme. Behind it, the guide's bar starts with Pages and Fix list (14).](/docs-assets/guides/overview/guide-switcher.webp)
