---
title: Publish your site
nav: Publishing
description: See what changed, publish a Docs Studio site, follow the build until it's live, and put an earlier publish back.
updated: 2026-10-31
prerequisites: [/docs-studio/editor]
keywords: [publish, go live, build, changes, release, restore, rollback, unpublish, publish history, building]
---

Drafts are private. Publishing takes every page's current draft and the site's settings, builds the site, and puts it live at its address. Readers keep seeing the previous version until the new one is ready, a few seconds later.

Open the site's **Publishes** tab, or choose **Publish…** in the editor.

## See what changed

The left side lists the changes since the last publish:

- pages that are **New**, **Edited** (with how many lines changed and who changed them) or **Deleted**, each with **View changes** to open the page
- site settings that changed, like **Theme and brand**, **Sidebar order**, **Ask AI** or **Redirects**, each with **Open**

Before the first publish, every page shows as new. When nothing has changed, it says **Everything is published**.

![Acme's Publishes tab: 4 changes since the last publish (Quickstart and Alert rules edited by Alex, a new Workflows page, and Sidebar order), the Publish 4 changes form, and on the right the list of publishes with the live one first.](/docs-assets/docs-studio/publishing/publish-screen.webp)

## Publish the changes

::::steps
### Describe it
Under **Publish**, add a note in **What changed (optional)**, like "Rewrote Quickstart for the new onboarding". It's shown in the publish history.

### Publish
Choose **Publish**. The new publish appears at the top of **Publishes** with its progress: **Waiting to build**, then **Building the site** with each step.

### It's live
When it's done, the publish is marked **Live** and a message says where. Readers see the new version within a few seconds.
::::

::clip{src="/docs-assets/docs-studio/publishing/publish-to-live" alt="Typing the note 'Release notes: webhook headers', choosing Publish, the new publish showing Waiting to build in the list, then the message Published. Live at acme-themes.docs.markdrop.in and the publish marked Live."}

If the site [requires a review](/docs-studio/reviews), editors and reviewers see **Submit for review** instead of **Publish**. Admins can always publish.

Publishing while a build is running is fine: changes that come in meanwhile go into the next publish, and a publish that hasn't started yet is replaced by the newer one (it's listed as replaced, not built).

:::note[If a publish fails]
It's marked **Failed** with the reason, and nothing changed for readers: they keep the last live version. Fix what it says and publish again. See [Troubleshooting](/docs-studio/faq#a-publish-failed).
:::

There's a daily number of publishes per site while Docs Studio is in beta. If you reach it, the message says so; restoring an earlier publish doesn't count.

## What gets published

- every page's current draft, including [hidden pages](/docs-studio/pages-and-navigation#hidden-pages)
- the sidebar order, theme and brand, Ask AI settings and redirects
- the images and files the pages use

Deleted pages disappear from the site. A publish takes each page's draft as last saved at the moment you choose **Publish**; edits saved after that wait for the next one.

## Restore an earlier publish

Every publish is kept. A Docs Studio admin can put an earlier one live again:

1. In **Publishes**, choose **Restore** on the publish you want.
2. Confirm with **Restore**.

![The dialog "Put publish #2 live?": Readers see "Postgres guide and alert rules" in a few seconds. Your drafts don't change, and you can switch back any time.](/docs-assets/docs-studio/publishing/restore-dialog.webp)

It takes a few seconds and doesn't rebuild anything. Your drafts don't change, so the next **Publish** publishes them again. To switch back, restore the newer publish.

## Take a site down

**Unpublish** in [Site settings](/docs-studio/site-settings#unpublish-or-delete) takes the site offline and keeps everything; publishing again puts it back.
