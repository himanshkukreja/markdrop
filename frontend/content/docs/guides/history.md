---
title: History and versions
nav: History and versions
description: Every save of a Markdrop Guides page is a version you can view and restore, and every publish is kept so an admin can put it live again.
updated: 2026-11-02
prerequisites: [/guides/editor]
keywords: [history, versions, restore, undo, page versions, publish history, rollback, revert]
---

Markdrop Guides keeps two kinds of history: each **page's versions** (its drafts) and the guide's **publishes** (what readers saw).

## Page versions

Every save of a page is a version: who saved it and when. The editor saves as you type, so you rarely lose more than a few seconds of work. A page keeps its last 50 versions.

The **History** tab of the editor's page panel lists them, newest first (**Version history** under the panel opens it too):

- **Edited**: a save from the editor.
- **Imported**: the page as it came from [GitBook](/guides/import-from-gitbook), or from [GitHub](/guides/import-from-github) at an import or a sync.
- **Restored an earlier version**: a restore, below.

![The History tab of Quickstart: four saves, the current one by Alex Chen today and earlier ones by Maya Patel and Riya Sharma, each with View.](/docs-assets/guides/history/versions-drawer.webp)

**View** opens a version beside the page: its title, description and Markdown.

### Restore a version

**View** a version, choose **Restore this version**, then **Restore**. Its text, title and description become the newest draft of the page. Nothing is lost: the draft you had stays in the history, so you can restore it back. The page's address, icon and sidebar setting don't change.

A restore changes the draft only. Readers see it after the next [publish](/guides/publishing).

To restore, you need to be able to edit the page: an Editor, Reviewer or Admin, with the page not open by someone else. Viewers can look at every version.

## Publishes

**Publish history** on the guide's **Publish** tab lists every publish, newest first: its number and note, when, who published it, how long it took, and what it changed (**+N pages**, **N edited**, **N removed**, **Design**). The one readers see now is marked **Live**. **What changed** compares a publish with the one before it, and **Compare two publishes** compares any two (see [Compare versions](/guides/publishing#compare-versions)).

![Acme's Publish history: #4 Release notes for 2.4 (Live, 1 edited), #3 Quickstart for the new onboarding (1 edited), #2 Postgres guide and alert rules (2 edited) and #1 First version (+13 pages), each with when, who, how long it took and What changed, the earlier ones with Restore, and Compare two publishes.](/docs-assets/guides/history/publishes-list.webp)

An admin can put an earlier publish live again with **Restore**. It takes a few seconds, doesn't rebuild anything, and doesn't touch your drafts. See [Restore an earlier publish](/guides/publishing#restore-an-earlier-publish).

## Who changed roles

Role changes have their own history: **Recent changes** on the Members page and **History** in a guide's People settings. See [Members and roles](/guides/members-and-roles#history).

## Related

- [Publish your guide](/guides/publishing#restore-an-earlier-publish): restore an earlier publish.
- [Reviews](/guides/reviews): approve changes before they go live.
