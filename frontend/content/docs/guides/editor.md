---
title: Write in the editor
nav: The editor
description: "The page editor: blocks and the slash menu, drag and drop, Markdrop files and private sections, AI help, find and replace, checks, comments and locks."
updated: 2026-11-04
prerequisites: [/guides/create-a-site]
keywords: [editor, visual editor, markdown, slash menu, blocks, drag and drop, reorder cards, markdrop file, embed, private section, video, callout, steps, tabs, cards, code block, image, dark mode image, ai, ask ai, rewrite, translate, find and replace, checks, broken links, alt text, comments, review, shortcuts, autosave, lock, conflict, preview]
---

Open a guide and its **Pages** tab is the editor: the page tree on the left, the page in the middle, and the page panel on the right (**Checks**, **Page**, **Comments** and **History**). On a phone, **Pages** and **Page** in the bar open the tree and the panel.

![The Markdrop Guides editor on Acme's Quickstart page: the guide's bar (Pages, Fix list 14, Changelog, Design, Publish 4, Insights, Settings, Saved, Visual and Markdown, Preview, Live and Publish 4 changes), the page tree with groups Getting started, Guides, Reference and Help and the Hidden pages, the page with its place in the guide, title, description, a note callout and tabs, and on the right the page panel on Checks (Headings and links look good, then On this page). Under the page, the word count, Embed a Markdrop file, Find and replace and Shortcuts.](/docs-assets/guides/editor/editor-overview.webp)

Only people with the Editor, Reviewer or Admin role can edit. Viewers see the same screen with **View only** in the bar. See [Members and roles](/guides/members-and-roles).

## The page tree

The tree lists the guide's groups and pages in sidebar order, each page with its icon. **Search pages** filters it by title or address, **+** adds a page, and a group's name folds it away (the tree remembers which, in this browser). Drag a page or a group by the grip beside it to move it, or use a page's **⋯** menu to move it up, down or to another group, or delete it. See [Pages and navigation](/guides/pages-and-navigation#move-reorder-and-delete).

One small dot beside a page means it's new or changed since the last publish. Point at it to see which. A lock with a name means someone else is editing that page, a speech bubble with a number counts its open review comments, a padlock marks a [private page](/guides/private-pages), and a GitHub mark a page that [comes from GitHub](/guides/import-from-github#editing-in-the-editor).

## The page header

Above the text, every page has its place in the guide (group › page, then its address), its **title** and its **description**: one sentence shown under the title, in search results and link previews, and in the guide's `llms.txt`. The **Page** tab has the rest: the address, the page's **Icon** (from Markdrop's icon set, shown beside the page in the sidebar), the description with its length, and **Show in the sidebar**.

## Visual or Markdown

The **Visual** / **Markdown** switch in the bar changes how you edit, not what's saved. **Markdown** shows the page as the file it is: a front matter block with `title`, `description` and `icon`, then the body. Markdrop Guides remembers your choice in this browser.

![The Quickstart page in Markdown mode, with Markdown selected in the bar: front matter with title, description and icon, then headings, a :::note callout and a ::::tabs block as plain text.](/docs-assets/guides/editor/editor-markdown.webp)

The Markdown is the same format docs.markdrop.in is written in: callouts are `:::note`, steps are `::::steps`, tabs are `::::tabs` and so on. Anything the visual editor can't show as a block, it keeps exactly as written and labels "Edit it in Markdown mode". Switching back and forth changes nothing.

**Preview** shows the draft as readers will see it, in the guide's saved design: its theme, colours, fonts and corners, light or dark. A design you haven't saved yet doesn't show. Links and cards in the preview open their page in the editor.

## The slash menu

Type `/` on a new line, or after a space, to insert a block. An empty line says **Type / for blocks**. Keep typing to filter, like `/tip` or `/code`, then press Enter. (It doesn't open inside code blocks and tables.)

::clip{src="/docs-assets/guides/editor/editor-slash-callout" alt="In the Invite your team page, a new line, typing /tip, choosing Tip callout, and typing a sentence into the new tip."}

You can also use the **+** in the margin: beside the empty line you're on, or beside any block you point at (**Add a block below**). Drag the grip beside a block to move it, or click it for **Move up**, **Move down**, **Duplicate** and **Delete**. Alt + Shift + ↑ or ↓ moves the block with the keyboard.

Cards have a grip of their own: drag a card to reorder it in its grid or move it into another grid, and a line shows where it lands (Esc cancels). Click the grip for **Move left**, **Move right** (**Move up** and **Move down** in a one-column grid) and **Delete**, or press Alt + ← or → on it. The Markdown of the cards is kept exactly as written.

## Formatting

Select text for the formatting bar: **Bold**, **Italic**, **Inline code**, **Link**, **Turn into heading** (text, heading, subheading or small heading), **Turn into list** (bulleted, numbered or a quote) and **More formatting** (strikethrough and keyboard key). Then **Ask AI** and **Comment**.

A link can be a page of the guide (`/guides/alert-rules`), a section (`#install`) or any `https://` address.

## Ask AI

Select a sentence or a few paragraphs, choose **Ask AI**, then:

![A paragraph of Quickstart selected, with the formatting bar above it and the Ask AI menu open: Improve the writing, Make it shorter, Fix spelling and grammar, and Translate….](/docs-assets/guides/editor/editor-ai-menu.webp)

- **Improve the writing**: clearer and more direct, about the same length
- **Make it shorter**: about half, keeping the facts, steps and warnings
- **Fix spelling and grammar**: nothing else changes
- **Translate…**: pick a language (31 of them; type to filter)

The answer appears under the text as a suggestion, and the passage it would replace stays highlighted. Nothing changes until you choose **Accept**. **Try again** asks for another version, and **Discard** (or Esc) drops it. An accepted suggestion is one step in the undo history, so ⌘ Z (Ctrl Z) brings your words back.

![Make it shorter on the Before you start paragraph: the paragraph stays highlighted, and under it the suggestion "You need an Acme account and the address of a database Acme can reach." with Accept, Try again and Discard, and "Check it before you accept. AI can make mistakes."](/docs-assets/guides/editor/editor-ai-suggestion.webp)

AI help keeps links, code, Markdown and blocks like callouts as they are, and it never follows instructions written in your text. Still, read a suggestion before you accept it.

The editor has the rest of the writing tools from Markdrop pages too: **⌘ J** opens **Ask AI** on the selection, or drafts at the caret when nothing is selected, and the **AI** menu in the status bar has **Ask AI to write…**, **Summarize page**, **Find action items** and **Suggest title & description**. Images you add get suggested alt text. They all work as described in [AI in pages](/pages/ai), and every use counts toward the guide's AI budget below.

Limits:

- A selection can be up to 6,000 characters.
- Each person can use AI help 50 times a day (UTC).
- AI help shares the guide's AI budget with its readers' [Ask AI](/guides/ask-ai): every use counts towards the same monthly allowance. When it's used up, AI help says "This guide's AI budget for the month is used up" until the 1st (UTC).

Only the selection and the action are sent to the model, and nothing of either is kept: Markdrop records that AI help was used (which action, how long the text was, the cost), never the text or the answer.

## Find and replace

⌘ F (Ctrl F on Windows and Linux) opens **Find and replace** on the page, in Visual and Markdown mode, with the selected text as the search. **Aa** matches case, **ab** matches whole words only. Enter goes to the next match and Shift + Enter to the previous one. The arrow beside the search shows **Replace with**: **Replace** changes the current match, **Replace all** every match (⌘ Enter in that box). Esc closes it. The status bar under the page has the same button, beside the word count and reading time.

![Find and replace over Quickstart: "workspace" in Find with 1 of 2, Aa and ab, the arrows and close; Replace with "team", Replace and Replace all; the first match marked in the note callout.](/docs-assets/guides/editor/editor-find-replace.webp)

In Visual mode, find looks at the text you see; the Markdown behind it (link addresses, a callout's title) is in Markdown mode.

## Checks

The **Checks** tab looks over the page as you write, and its count is the number of things to look at:

| Check | What to do |
| --- | --- |
| **Link to a page that doesn't exist** | **Create the page** makes a draft at that address, or fix the link. |
| **Link to an unpublished page** | The page is new: readers get "page not found" until it's published too. |
| **Image without a description** | **Add a description** for screen readers and search engines. |
| **Empty heading** | **Remove them** deletes headings with no words. |
| **Two headings with the same anchor** | Links to that section always open the first one: give each heading its own words. |
| **Long page** | Over 3,500 words. Consider splitting it. |

**Show** scrolls to the problem and selects it. In the page itself, a problem link has a wavy underline (point at it to see why) and an image without a description has a dashed outline. When headings and links are fine, the tab says **Headings and links look good**.

![Checks 2 on Acme Developers' Authentication page: Link to a page that doesn't exist ("rotate it" goes to /guides/key-rotation) with Show and Create the page, and Image without a description with Show and Add a description. In the page, "rotate it" has a wavy underline and the architecture diagram a dashed outline.](/docs-assets/guides/editor/editor-checks.webp)

Under the checks, **On this page** lists the page's headings and subheadings, as readers see them. The section you're reading is marked; choose one to jump to it.

## Comments

Select text and choose **Comment** to ask a question or suggest a change about it, then **Comment** again (or ⌘ Enter). Comments are for the guide's Editors, Reviewers and Admins, and they never reach readers. **Comment on selection** in the **Comments** tab works on a page someone else is editing too.

Commented text is highlighted in the page; choose it to open its thread. In a thread you can **Reply**, **Resolve** (it moves to **Resolved**, where **Reopen** brings it back) and, for your own comments (or as an Admin), **Delete**. The tab's count is the open comments, and the tree shows each page's. There are no notifications: open comments show as counts.

![The Comments tab on Quickstart with one open thread on "A read-only user is enough.", highlighted in the page: Noah Kim asks "Can we say which permissions? Support gets this question every week." and Alex Chen replies, with Reply and Resolve.](/docs-assets/guides/editor/editor-comments.webp)

## Who else is here

When other people have the guide's editor open, their pictures are in the header with "Asha is here". Point at one to see which page they're on and whether they're editing it; choose it to open that page. The panel's footer says who last edited this page and who is editing which page right now, with **Version history**.

![The studio header with Maya's and Alex's pictures and "Maya and Alex are here", Alex's marked as editing.](/docs-assets/guides/editor/editor-presence.webp)

## Images

Add an **Image** block, then **Upload an image**, drop one onto it, or paste an image address. A file can be up to 25 MB. Select the image for its tools:

- **Alt text**: what the image shows, for people who can't see it. "(missing)" means there's none yet.
- **Add a caption** under the image.
- **Replace** uploads a new image in its place.
- **Add dark version**: an image to show instead when the reader has the guide in the dark theme, like a screenshot taken in dark mode. Readers see the one that matches their theme.

![An image block selected in the editor, with Alt text, Replace, Add dark version and a delete button under it.](/docs-assets/guides/editor/image-block.webp)

## Blocks

| Block | What it's for |
| --- | --- |
| **Text**, **Heading**, **Subheading** | Paragraphs and section titles. Headings make the page's contents list. |
| **Callout**, **Tip callout**, **Warning callout**, **Danger callout** | Notes, shortcuts, things to be careful about, and data-loss or security risks. Each can have a title. |
| **Steps** | A numbered how-to: each step has a title and text. |
| **Tabs** | The same thing for macOS, Windows and Linux, or for several languages. |
| **Cards** | Links to other pages, with an icon each. The grid balances itself (four cards make a 2 × 2 square); choose **Columns** under the grid to set 1 to 4. |
| **Details** | A collapsible section, good for FAQs. |
| **Image** | An image with a caption, alt text and an optional dark-theme version. |
| **Code** | Code with a language, an optional title and a copy button. |
| **Table** | Rows and columns, with a header row. |
| **Bulleted list**, **Numbered list**, **Checklist** | Lists. |
| **Quote**, **Divider**, **Keyboard key** | A quotation, a horizontal line, and keys like Ctrl K. |
| **Math** | A LaTeX formula, previewed as you type. |
| **Private section** | Part of a public page that only some readers see: your team, a customer's people or partners with a password. See [Private pages and sections](/guides/private-pages#a-private-section-in-a-public-page). |
| **Markdrop file** | An interactive HTML demo, a zipped site, a PDF or a video from Markdrop, live in the page, with a text version for search and AI. See [Embed files that render](/guides/embed-files). |
| **Video** | A video you upload, or a Markdrop video link, in the docs player. Add WebVTT captions and chapters from the block. |
| **Clip** | A short silent loop, like a GIF but lighter. |
| **API endpoint** | A card with the method and path you type. With an [API reference](/guides/api-reference), the block offers your file's endpoints, and the card links to the endpoint's page. |

The menu also lists **Embed**, a page from another site, which shows as a link card on a guide. To put a live demo in a page, publish it on Markdrop and use **Markdrop file**: the status bar under the page has **Embed a Markdrop file** too.

## Keyboard shortcuts

Press `?` (when you're not typing) or **Shortcuts** in the status bar for the list. On Windows and Linux, use Ctrl for ⌘ and Alt for ⌥.

![The Keyboard shortcuts sheet: Text (bold, italic, strikethrough, inline code, link, keyboard key), Page (find and replace, next and previous match, undo, redo, send a comment, this sheet) and Blocks (block menu, headings, lists, quote, code block, move a block, move a card, line break), and Page tree (on a page's grip: pick up or drop, move, cancel).](/docs-assets/guides/editor/editor-shortcuts.webp)

| Shortcut | Does |
| --- | --- |
| :kbd[⌘ B], :kbd[⌘ I], :kbd[⌘ E] | Bold, italic, inline code |
| :kbd[⌘ ⇧ S], :kbd[⌘ ⇧ K] | Strikethrough, keyboard key |
| :kbd[⌘ K] | Link (with text selected) |
| :kbd[⌘ J] | Ask AI on the selection, or write at the caret |
| :kbd[⌘ ⌥ 2], :kbd[⌘ ⌥ 3] | Heading, subheading |
| :kbd[⌘ ⇧ 8], :kbd[⌘ ⇧ 7], :kbd[⌘ ⇧ B] | Bulleted list, numbered list, quote |
| :kbd[⌘ ⌥ C] | Code block |
| :kbd[/] | The block menu |
| :kbd[Alt ⇧ ↑], :kbd[Alt ⇧ ↓] | Move the block up or down |
| :kbd[⇧ Enter] | A line break (in a table, the next row) |
| :kbd[⌘ F] | Find and replace |
| :kbd[⌘ Z], :kbd[⌘ ⇧ Z] | Undo, redo |
| :kbd[⌘ Enter] | Send a comment or reply |
| :kbd[Alt ←], :kbd[Alt →] | Move a card (on its grip) |
| :kbd[Space], then :kbd[↑] :kbd[↓], :kbd[Space] | Pick up, move and drop a page in the tree (on its grip); :kbd[Esc] cancels |

Markdown shortcuts work as you type: `## ` for a heading, `- ` for a list, `> ` for a quote, three backticks for code.

## Saving

There's no Save button. Drafts save themselves a moment after you stop typing, and the bar says where the draft is: **Unsaved changes**, **Saving…**, then **Saved** (point at it for when). **Not saved · Retry** means the save didn't go through: choose it to try again. Every save is a version in the page's [history](/guides/history), in the **History** tab.

Saved drafts aren't public. Readers see a change after the next [publish](/guides/publishing).

## One editor per page

While you have a page open, it's yours to edit. Anyone else who opens it sees **Read only**, a lock beside the page in the tree with your name, and a note that it opens for editing when you're done. They can still read it and comment on it. Leaving the page lets go of it. If your browser closes without leaving, the page frees itself two minutes later.

![Acme's Connect Postgres page opened by Riya while Alex has it: the banner "Alex Chen is editing this page" with Take over, Read only in the bar, and a lock with Alex's name beside the page in the tree.](/docs-assets/guides/editor/page-locked.webp)

A Guides admin can choose **Take over**. The other person's unsaved typing is lost, and they see a banner saying who took over the page, with **Copy my text** (their text to the clipboard), **Load their version** and, for admins, **Take it back**.

## When someone saved first

If the page was saved by someone else since you opened it, Markdrop Guides stops and asks, in **Someone saved a newer version**:

- **Keep mine** saves your text as the newest version. Theirs stays in the history.
- **Use their version** drops your unsaved changes.
- **Copy my text** puts your text on the clipboard first.

## Related

- [Pages and navigation](/guides/pages-and-navigation): the page tree and addresses.
- [Embed files that render](/guides/embed-files): the Markdrop file block.
- [Private pages and sections](/guides/private-pages): the Private section block.
- [History and versions](/guides/history): every save.
- [AI in pages](/pages/ai): the same AI tools in Markdrop pages.
