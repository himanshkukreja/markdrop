---
title: Working together on a page
description: What happens when people and AI apps change the same page. Changes to different parts are merged, and nothing is saved over a newer version unasked.
updated: 2026-11-05
prerequisites: [/pages/overview]
keywords: [collaboration, working together, two people, conflict, this page changed, keep both, use theirs, use mine, merge, merged, newer version, overwrite, lost changes, offline, sleep, reconnect, renamed, deleted, removed from workspace, access, ai apps, mcp, base_rev, rev, update_document, update_page, concurrent edits, sub-pages, views]
---

Several people can have a page open at once, and AI apps connected through [MCP](/ai/tools#pages) can change it while they do. Markdrop keeps everyone's work: changes to different parts of a page are merged, and nothing is saved over a newer version without asking you first.

## One person types at a time

The first time you type in a page, it's held for you and others see **Editing** next to your name. While it's yours, other people (and AI apps changing the whole page) wait until you're done. AI apps can still add blocks to the end, and they appear in your page as you type. See [One editor at a time](/pages/overview#one-editor-at-a-time).

## An open page keeps up

A page you have open, but aren't typing in, shows other people's changes as they're saved: a teammate's edit, an AI app's rewrite, new sub-pages under **Pages inside**. You don't need to reload.

When your connection drops, your laptop sleeps or Markdrop restarts, the page catches up when it's back: it checks for changes made meanwhile, shows them, and saves anything you typed while you were offline.

## When two changes meet

Sometimes you type into a page that changed elsewhere since you last saw it, for example when you come back to a laptop that was asleep. When your change is saved, Markdrop merges it with the newer version:

- **You changed different parts.** Both changes are kept, and the page shows the merged version. Nothing to do.
- **You both added to the end.** Both additions are kept: theirs first, then yours.
- **You both changed the same lines.** A banner says **Someone else changed the same part of this page while you were editing**. Their other changes stay whichever you choose:
  - **Keep both**: their version of those lines, then yours, one after the other. Delete the one you don't want.
  - **Use theirs**: your change to those lines goes. It stays in this browser, and you're offered it back the next time you open the page.
  - **Use mine**: your version of those lines replaces theirs. Their other changes stay, and theirs is in [version history](/pages/history).

Nothing is ever lost without a trace: every saved version is in [version history](/pages/history), with who saved it.

## Unsaved changes from earlier

If you closed a page before your changes were saved, the next time you open it you're offered **Restore them**. If the page changed since, your changes are merged into the newer version, not saved over it. Where both changed the same lines, both versions are on the page, theirs first.

## When a page moves, goes or locks you out

- **Renamed** (its link changed) while you have it open: what you typed is saved, and your tab moves to the new address.
- **Deleted** while you have it open: the page says so and stops saving. What's on screen stays, so you can copy it. The owner can restore it from [Trash](/documents/trash).
- **Your access changes** (removed from the workspace, or made a viewer): open pages check again at once. A viewer sees the page to read; someone who can't open it any more sees why.

## AI apps and people

AI apps write to pages with the same rules as people:

- `update_page` takes the `base_rev` that `get_page` returned. If the page changed since, nothing is written and the app is told to read it again.
- `replace_section`, `set_page_properties` and `insert_embed` change the page as it is when they run, never an older copy.
- `append_blocks` adds to the end, even while someone is typing.
- `update_document` takes an optional `base_rev` (the `rev` from `get_document`). With it, a document that changed since is never overwritten. Without it, the app replaces whatever is there, so apps should always pass it.

## Folder views

Two people changing a folder's saved views (Table, Board, filters and sorts) at the same time both keep their changes: a change is applied to the views as they are now, not to an older copy. See [Properties and views](/pages/properties-and-views).
