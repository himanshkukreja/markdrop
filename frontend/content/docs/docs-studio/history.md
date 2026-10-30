---
title: History and versions
nav: History and versions
description: Every save of a Docs Studio page is a version you can view and restore, and every publish is kept so an admin can put it live again.
updated: 2026-10-31
prerequisites: [/docs-studio/editor]
keywords: [history, versions, restore, undo, page versions, publish history, rollback, revert]
---

Docs Studio keeps two kinds of history: each **page's versions** (its drafts) and the site's **publishes** (what readers saw).

## Page versions

Every save of a page is a version: who saved it and when. The editor saves as you type, so you rarely lose more than a few seconds of work. A page keeps its last 50 versions.

The page settings panel shows the latest three under **History**. Choose **See all versions** for the full list:

- **Edited**: a save from the editor.
- **Imported**: the page as it came from [GitBook](/docs-studio/import-from-gitbook).
- **Restored an earlier version**: a restore, below.

![All versions of Quickstart: four saves, the current one by Alex Chen today and earlier ones by Maya Patel and Riya Sharma, each with View and Restore.](/docs-assets/docs-studio/history/versions-drawer.webp)

**View** shows a version's title, description and Markdown.

### Restore a version

Choose **Restore** on a version, then **Restore** again. Its text, title and description become the newest draft of the page. Nothing is lost: the draft you had stays in the history, so you can restore it back. The page's address, icon and sidebar setting don't change.

A restore changes the draft only. Readers see it after the next [publish](/docs-studio/publishing).

To restore, you need to be able to edit the page: an Editor, Reviewer or Admin, with the page not open by someone else. Viewers can look at every version.

## Publishes

The **Publishes** tab lists every publish, newest first: its note (or **Publish #** and its number), who published it, when, and how long it took. The one readers see now is marked **Live**.

![Acme's Publishes: Release notes for 2.4 (Live), Quickstart for the new onboarding, Postgres guide and alert rules, and First version, each with Restore.](/docs-assets/docs-studio/history/publishes-list.webp)

An admin can put an earlier publish live again with **Restore**. It takes a few seconds, doesn't rebuild anything, and doesn't touch your drafts. See [Restore an earlier publish](/docs-studio/publishing#restore-an-earlier-publish).

## Who changed roles

Role changes have their own history: **Recent changes** on the Members page and **History** in a site's People settings. See [Members and roles](/docs-studio/members-and-roles#history).
