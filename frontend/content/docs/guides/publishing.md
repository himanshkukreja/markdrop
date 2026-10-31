---
title: Publish your guide
nav: Publishing
description: See what changed, publish a guide, follow the build until it's live, and put an earlier publish back.
updated: 2026-11-01
prerequisites: [/guides/editor]
keywords: [publish, go live, build, changes, release, restore, rollback, unpublish, publish history, building, compare, diff, what changed]
---

Drafts are private. Publishing takes every page's current draft and the guide's settings, builds the guide, and puts it live at its address. Readers keep seeing the previous version until the new one is ready, a few seconds later.

Every screen of a guide has the same bar under the header: the **Publish** tab shows how many changes are waiting, **Live ·** and the guide's address opens the live guide in a new tab, and **Publish N changes** publishes from wherever you are. When there's nothing to publish it says **Up to date**.

![The guide's bar on Acme's Insights tab: the tabs Pages, Design, Publish with a 4, Insights and Settings, then Live · acme.guides.markdrop.in, Preview and Publish 4 changes. Above it, the header with the guide switcher (Acme), its workspace and the Admin badge.](/docs-assets/guides/publishing/site-bar.webp)

## See what changed

The **Publish** tab says **N changes ready to publish**, with what kind (new, edited and removed pages, a new design, redirects, the API reference) and the list:

- pages that are **New**, **Edited** (who changed them and when) or **Removed**, each with **Compare** to see the change line by line
- guide settings that changed, like **Design**, **Sidebar order**, **Ask AI** or **Redirects**, each with **Open**

On the right, **Readers see now** shows the address readers use (open it in a new tab, or copy it) and which publish they see. Before the first publish, every page shows as new.

![Acme's Publish tab: 4 changes ready to publish (1 new page, 2 edited, Sidebar order), listing Quickstart and Alert rules edited by Alex and the new Workflows page, each with Compare, and Sidebar order with Open. On the right, Publish with What changed (optional), Publish 4 changes and Preview first, and Readers see now: acme.guides.markdrop.in, publish #4.](/docs-assets/guides/publishing/publish-screen.webp)

## Publish the changes

::::steps
### Describe it
Under **Publish**, add a note in **What changed (optional)**, like "Rewrote Quickstart for the new onboarding". It's shown in the publish history.

### Publish
Choose **Publish N changes** (or **Preview first** to look at it before). The tab shows the publish's progress: the snapshot of your pages, building the pages, search, Ask AI and link previews, then going live at the guide's address, with about how long is left. You can keep editing or close the page meanwhile.

### It's live
When it's done, a message says **Publish #N is live**, with **Open**. The **Publish** tab shows **Your guide is live** with every address it answers at, each with **Copy** and **Open**.
::::

![Publishing your guide: the progress bar, Saved a snapshot of your pages (1 change) done, Building the pages under way, then Search, Ask AI and link previews, and Going live at acme-themes.guides.markdrop.in, about how long is left, with Back to the editor; below, In this publish: 1 edited page and its note.](/docs-assets/guides/publishing/publish-progress.webp)

::clip{src="/docs-assets/guides/publishing/publish-to-live" alt="Typing the note 'Release notes: webhook headers', choosing Publish, the new publish showing Waiting to build in the list, then the message Published. Live at acme-themes.guides.markdrop.in and the publish marked Live."}

If the guide [requires a review](/guides/reviews), editors and reviewers see **Send for review** instead of **Publish**. Admins can always publish.

## Compare versions

**Compare** on a change, **What changed** on a publish in the history, or **Compare two publishes** opens **What changed**: pick any two publishes, or a publish and **Unpublished changes (drafts)**. It lists the pages added, edited and removed (with lines added and removed), says whether the design and redirects changed, and shows the selected page's Markdown line by line, as **Text** or **Side by side**. **Open live page** opens that page on the live guide.

![What changed from #4 (Live, Release notes for 2.4) to Unpublished changes (drafts): 1 page added, 2 pages edited, 0 removed, design and redirects unchanged; the pages Workflows (new), Quickstart and Alert rules, and Quickstart's Markdown with four added lines, a new Invite your team section, shown as Text.](/docs-assets/guides/publishing/publish-compare.webp)

## Finish setting up

Once the guide is live, the **Publish** tab lists what's left to set up: pages, a look, publishing, your own domain, your team and Insights. Each step that isn't done has a button that takes you there.

![A guide with nothing waiting: Your guide is live, with its address, Copy and Open, the publish readers see and who published it, and Open the guide, Keep writing and Share; below, Finish setting up (2 of 5 done) with Design, Add domain and Insights buttons for the steps left, and the Publish history.](/docs-assets/guides/publishing/publish-live.webp)

Publishing while a build is running is fine: changes that come in meanwhile go into the next publish, and a publish that hasn't started yet is replaced by the newer one (it's listed as replaced, not built).

:::note[If a publish fails]
It's marked **Failed** in the publish history with the reason, and nothing changed for readers: they keep the last live version. Fix what it says and publish again. See [Troubleshooting](/guides/faq#a-publish-failed).
:::

There's a daily number of publishes per guide while Markdrop Guides is in beta. If you reach it, the message says so; restoring an earlier publish doesn't count.

## What gets published

- every page's current draft, including [hidden pages](/guides/pages-and-navigation#hidden-pages)
- the sidebar order, theme and brand, Ask AI settings and redirects
- the images and files the pages use

Deleted pages disappear from the guide. A publish takes each page's draft as last saved at the moment you choose **Publish**; edits saved after that wait for the next one.

## Restore an earlier publish

Every publish is kept. The **Publish history** shows each one with what it changed (pages added, edited and removed, the design). A Guides admin can put an earlier one live again:

1. In **Publish history**, choose **Restore** on the publish you want.
2. Confirm with **Restore**.

![The dialog "Put publish #2 live?": Readers see "Postgres guide and alert rules" in a few seconds. Your drafts don't change, and you can switch back any time.](/docs-assets/guides/publishing/restore-dialog.webp)

It takes a few seconds and doesn't rebuild anything. Your drafts don't change, so the next **Publish** publishes them again. To switch back, restore the newer publish.

## Take a guide down

**Unpublish** in [Guide settings](/guides/site-settings#unpublish-or-delete) takes the guide offline and keeps everything; publishing again puts it back.
