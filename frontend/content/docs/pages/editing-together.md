---
title: Editing together
description: One person edits a page at a time, and only while they're actually editing. A tab left open never blocks anyone, and admins can take over.
updated: 2026-11-05
prerequisites: [/pages/overview]
keywords: [edit lock, lock, is editing, someone else is editing, editing, take over, edit anyway, idle, away, unsaved changes, collaboration, concurrent editing, one editor, read only, take_over, mcp, locked error]
---

A page is edited by one person at a time. While someone is editing, everyone else sees the page read only, with their changes arriving live, and the bar says who it is. As soon as they stop, anyone who can edit the page can carry on.

## When a page counts as being edited

You're editing a page from your **first real change**: typing, pasting, adding or moving a block, changing the cover, the icon or a page option. Opening a page, scrolling, clicking into it or selecting text doesn't count, so a page you only read never blocks anyone, even if its tab stays open all day.

You stop editing, and others can edit, when:

- **2 minutes pass without a change**, even if the tab is still open in front of you;
- **your tab has been in the background for 60 seconds** (another tab, another app, a locked screen);
- **you leave the page or close the tab**: at once, whether you go to another page, open the sub-page you just added or close the window. Anything you typed in the last moment is saved on the way out;
- your browser quits without a word (it crashed, or the laptop shut down): about 10 seconds later;
- the tab loses its connection for 2 minutes.

What you typed is saved first, so nothing is lost when you stop. When you come back and type again, the page is yours again. If someone changed it in the meantime, you see their changes first and yours go on top.

Your own tabs count as one editor: with the same page open in two tabs, both stay editable and each shows what the other saved. If both change the same lines before either saves, the second save asks which version to keep.

## When someone else is editing

The page shows a banner such as **Venkat is editing (idle for 1 min, unsaved changes · free in about 1 min)**, and it's read only for you until they stop. You don't need to reload: when the page is free, it becomes editable again by itself.

People with access see who's editing by name, with a pencil on their avatar in [who's viewing](/sharing/see-whos-viewing). The pencil goes as soon as they stop editing, whether they closed the page or just left it alone.

## Edit anyway

The page's owner and the workspace's admins and owners see **Edit anyway** in the banner. It takes the page from the other person straight away:

- their editor says **Alex took over editing** and becomes read only, following your changes;
- anything they hadn't saved yet is kept as a version in the page's [version history](/pages/history), labelled with their name, so it can be copied or restored later. Nothing they typed is lost.

Use it when someone left a page open with changes you need to make now. Anyone else waits until the page is free.

## From an AI app

AI apps connected over [MCP](/ai/hosted-mcp) follow the same rules. While someone is editing a page, `update_page`, `replace_section`, `insert_embed` with `after_heading`, `set_page_properties`, `set_slug`, `restore_page_version`, `summarize_page` with `insert` and `update_document` are refused with an error that says who is editing, how long they've been idle, whether they have unsaved changes and when the page will be free. The same facts come as fields (`holder`, `idle_s`, `dirty`, `releases_in_s`, `can_take_over`) for the app to read. `append_blocks` always works: the editor shows the new blocks straight away.

If you're the page's owner or a workspace admin, the app can pass `take_over: true` to write anyway. The person editing is told, and their unsaved changes are kept in version history. A good AI app asks you before it does. See [MCP tools](/ai/tools#pages).

## Related

- [Pages and the block editor](/pages/overview)
- [Version history](/pages/history)
- [See who's viewing](/sharing/see-whos-viewing)
- [MCP tools](/ai/tools)
