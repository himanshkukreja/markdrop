---
title: Add a changelog to your guide
nav: Changelog
description: Write changelog entries in Markdrop Guides. Readers get a changelog page, a page per release, RSS and JSON feeds, and entries in search and Ask AI.
updated: 2026-11-01
prerequisites: [/guides/editor, /guides/publishing]
keywords: [changelog, release notes, what's new, product updates, rss, json feed, feed, subscribe, versions, coming next, roadmap, announcements, gitbook release notes]
---

A changelog tells readers what changed in your product: new features, improvements and fixes, newest first. In Markdrop Guides you write each release as an **entry**, and your guide gets a changelog page readers can browse, search and subscribe to.

Open a guide and choose **Changelog** in the bar at the top, next to **Pages**.

![Acme's published changelog, What's new: Updated with the date of the newest release, Subscribe, a search box, the kind filter (All, New, Improved, Fixed) and the latest release, Workflows (beta), with its image, highlights and a Read about alert rules button, then Coming next. On the left, Jump to lists the months and the Web app versions.](/docs-assets/guides/changelog/changelog-reader.webp "Acme's changelog on its published guide.")

## What readers get

Once you publish an entry, the guide has:

- **A changelog page** at `/changelog` on your guide's address, with a **Changelog** tab in the header. The newest release is shown large; earlier ones are grouped by month. Readers search the releases, filter them by kind (**New**, **Improved**, **Fixed**), area and product, and pick their version to see only what's new since. **Coming next** lists what you're working on.
- **A page for every entry** at `/changelog/<address>`, with its details, a **Copy link** button, the pages it changed and links to the releases before and after it.
- **Feeds.** **Subscribe** on the changelog page offers an RSS feed (`/changelog.rss`), a JSON Feed (`/changelog.json`) and a Markdown copy for AI tools (`/changelog.md`). Every link in them uses your guide's address: your own domain, once it's live and you've published since.
- **Link previews.** Each entry gets its own preview card, with its title, summary and date, for Slack, LinkedIn and the like.
- **Search and Ask AI.** Entries show up in the guide's search under **Changelog**, and [Ask AI](/guides/ask-ai) answers questions like "what's new since 2.3?" from them.
- **The home page.** On most themes, the home page lists the three newest entries under **What's new**.

![Acme's changelog with Subscribe open: Follow releases, RSS feed (for feed readers), JSON Feed (jsonfeed.org format), Markdown for AI (paste into Claude or ChatGPT) and Copy feed link.](/docs-assets/guides/changelog/changelog-reader-subscribe.webp)

![The page of one entry, Workflows (beta), on Acme's guide: All releases, its image, New, Workflows and the date, the title, the summary, two highlights, Read about alert rules, Copy link and the Web app 2.4 version, then the details.](/docs-assets/guides/changelog/changelog-reader-entry.webp)

The changelog is drawn in your guide's theme, colours and fonts, in light and dark, like every other page. A guide with no entries has no changelog page and no tab.

## Write an entry

Before the first entry, the Changelog screen shows what readers will get, and **See an example** previews a sample changelog in your guide's design.

![The Changelog screen before the first entry: Tell readers what's new, what readers get (a changelog page, RSS and JSON feeds, search and Ask AI, filters), Write the first entry and See an example, beside a sample changelog with three releases.](/docs-assets/guides/changelog/changelog-empty.webp)

1. Open **Changelog** and choose **Write the first entry** (or **New entry** once there's one).
2. Give it a **title** (what shipped) and a one-line **summary**. The summary is what the release cards, feeds and link previews show, so make it a full sentence.
3. Write the **details** if there's more to say. It's the same editor as your pages: type `/` for callouts, steps, code, images and the rest. The details show on the entry's own page and under **Read more** on the changelog page.
4. Fill in what applies on the right (see below), then choose **Create entry**.

Save later changes with **Save**, or ⌘ S (Ctrl S on Windows and Linux). If someone else saved the same entry meanwhile, Markdrop says who and lets you load their version or keep yours: nothing is overwritten silently.

![The entry editor for Workflows (beta): the title, the summary, the details in the page editor with a heading, steps and a note; on the right the date, area Workflows, kind New, the Web app product at version 2.4, two highlights, and the image with its description.](/docs-assets/guides/changelog/changelog-editor.webp)

| Field | What it does |
| --- | --- |
| **Date** | When it shipped. Entries are sorted by it, newest first. Today, unless you change it. |
| **Kind** | **New**, **Improved** or **Fixed**. Readers filter by it, and each kind has its own colour. |
| **Area** | The part of your product, like Dashboards or Billing (up to 40 characters). Readers filter by it. Markdrop suggests the areas you've used. Empty means **General**. |
| **Products and versions** | Which of your products it changed, and the version it needs (see [Products and versions](#products-and-versions)). |
| **Highlights** | Up to 8 short points, shown with check marks under the summary. |
| **Image or video** | An image, or a video with the image as its poster, shown at the top of the entry. Pick one from the guide's files or upload one (up to 25 MB), and describe it for readers who can't see it. Without one, the entry gets a cover drawn from its kind and products. |
| **Try it button** | A button on the entry: a page of your guide (`/quickstart`) or an `https://` address. |
| **Related pages** | Up to 10 pages of your guide this change touched, listed under **Docs updated**. |
| **Address** | The end of the entry's address, `/changelog/workflows-beta`. Made from the title when you create the entry. Changing it later breaks links people saved. |

## Find, change and remove entries

The **Changelog** screen lists every entry by month, newest first, with its kind, area, date, products and whether readers see it yet:

- **Published**: readers see this version.
- **Changed**: it's on the guide, but you've edited it since the last publish.
- **Not published**: readers haven't seen it yet.

Search the entries, or filter them by kind, or to the ones that aren't published yet. Each entry's **⋯** menu has **Edit**, **Preview**, **Open on the guide** (once it's published), **Duplicate** and **Delete**. A deleted entry stays on the live guide until the next publish.

![The Changelog screen for Acme: What's new, 6 entries, all published; search and the kind and status filters; entries grouped by month (November, October and September 2026), each with its date, kind, area, products and versions, title, summary and Published; on the right Where readers find it (the changelog page, RSS feed and JSON Feed with Copy), Coming next and Products.](/docs-assets/guides/changelog/changelog-list.webp)

**Preview** shows the changelog, or one entry's page, as the next publish would, in your guide's saved design, in light or dark.

![The preview of Acme's changelog in its saved design: What's new, Subscribe, search, the kind filter and the latest release, Workflows (beta).](/docs-assets/guides/changelog/changelog-preview.webp)

## Products and versions

If you ship one product, skip this: entries don't need to name one.

If you ship several (a web app, a CLI, an API), name them in **Settings › Products** on the Changelog screen. Then each entry can say which products it changed and, for each, the version it needs, like `2.4` or `v3.1.0-beta`. Readers see the product and version on the entry, filter by product, and on a guide where entries have versions, choose **Since my version** to see only what's new to them. The first product with versions also gets its own list on the changelog page, next to the months.

Taking a product off the list takes it off every entry that named it, with its version.

## Coming next

**Coming next** lists what you're working on, above the releases on the changelog page. Add up to 12 items in **Settings › Coming next**, each with a title and, if you like, an area and one line about it. Use the arrows to order them. Promise only what you'll ship, and take an item off once it's out.

![Changelog settings: The changelog page (title What's new, description), Products (Web app, CLI, API) and Coming next with two items, Single sign-on with Okta and Alert digests by email, each with its area, a note, arrows to reorder and Remove.](/docs-assets/guides/changelog/changelog-settings.webp)

In the same settings, **Title** names the changelog page and its feeds (Changelog, unless you change it). A short title, up to 24 characters, is also the header tab's label. **Description** goes under the title and in link previews.

## Publish

Entries are drafts until you publish, like pages. Every new, edited or deleted entry counts as a change: it's listed on [Publish](/guides/publishing) with **Open**, and it shows in **What changed** and in the publish history. Changes to the changelog's settings count as one change.

When a guide requires a [review](/guides/reviews), changelog entries go through it with everything else.

## Turn release notes into entries

If your guide already has a page of release notes, for example from a [GitBook import](/guides/import-from-gitbook), Markdrop can turn it into entries. It offers to when a page is called Changelog, Release notes, What's new or similar, and at least two of its headings have a date, either in the heading (`## March 4, 2026`, `## v2.3.0 (2026-02-12)`) or on the line under it.

You see the offer on the Changelog screen, and on the import screen once an import is done. Choose **Turn into N entries**:

- each dated heading becomes an entry: the heading without its date is the title (a heading that's only a version becomes "Version 2.3.0"), the text under it the details, and its first sentence the summary;
- the kind is guessed from the words (fixed, new, and the rest improved); check it;
- sections without a date are left out, because a date can't be guessed;
- the page itself stays as it is. Delete it, or keep it, once you're happy with the entries.

The new entries are drafts: read them, fix what needs fixing, then publish.

![The Changelog screen of the Northwind API guide with Release notes found: the page Release notes has 4 dated releases, August 18 to October 20, 2026, with Open the page and Turn into 4 entries.](/docs-assets/guides/changelog/changelog-release-notes.webp)

## Who can do what

| Role | Can |
| --- | --- |
| Viewer | See the entries and the preview |
| Editor, Reviewer, Admin | Write, change and delete entries, change the changelog's settings, turn release notes into entries |

Publishing follows the guide's usual rules. See [Members and roles](/guides/members-and-roles).

## Limits

- 500 entries per guide.
- A title is up to 120 characters, a summary up to 280, an entry's details up to 50,000.
- Up to 12 products and 12 Coming next items.

## Related

- [What readers get](/guides/what-readers-get): the changelog page and feeds.
- [llms.txt, MCP and agents](/guides/ai-ready): changelog.md and the whats_changed tool.
- [Publish your guide](/guides/publishing): entries go live with a publish.
