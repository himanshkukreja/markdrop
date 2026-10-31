---
title: Write in the editor
nav: The editor
description: Markdrop Guides' page editor. Blocks and the slash menu, AI help on a selection, find and replace, page checks, review comments, shortcuts, autosave and locks.
updated: 2026-11-01
prerequisites: [/guides/create-a-site]
keywords: [editor, visual editor, markdown, slash menu, blocks, callout, steps, tabs, cards, code block, image, dark mode image, ai, ask ai, rewrite, translate, find and replace, checks, broken links, alt text, comments, review, shortcuts, autosave, lock, conflict, preview]
---

Open a guide and its **Pages** tab is the editor: the page tree on the left, the page in the middle, and the page panel on the right (**Checks**, **Page**, **Comments** and **History**). On a phone, **Pages** and **Page** in the bar open the tree and the panel.

![The Markdrop Guides editor on Acme's Quickstart page: the page tree with groups Getting started, Guides, Reference and Help, the page with its title, description, a note callout and tabs, and on the right the page's Address, Show in the sidebar, Icon and History.](/docs-assets/guides/editor/editor-overview.webp)

Only people with the Editor, Reviewer or Admin role can edit. Viewers see the same screen with **View only** in the bar. See [Members and roles](/guides/members-and-roles).

## The page tree

The tree lists the guide's groups and pages in sidebar order, each page with its icon. **Search pages** filters it by title or address, **+** adds a page, and a group's name folds it away (the tree remembers which, in this browser). A page's **⋯** menu moves it up, down or to another group, or deletes it.

One small dot beside a page means it's new or changed since the last publish. Point at it to see which. A lock with a name means someone else is editing that page, and a speech bubble with a number counts its open review comments.

## The page header

Above the text, every page has its place in the guide (group › page, then its address), its **title** and its **description**: one sentence shown under the title, in search results and link previews, and in the guide's `llms.txt`. The **Page** tab has the rest: the address, the page's **Icon** (from Markdrop's icon set, shown beside the page in the sidebar), the description with its length, and **Show in the sidebar**.

## Visual or Markdown

The **Visual** / **Markdown** switch in the bar changes how you edit, not what's saved. **Markdown** shows the page as the file it is: a front matter block with `title`, `description` and `icon`, then the body. Markdrop Guides remembers your choice in this browser.

![The Quickstart page in Markdown mode: front matter with title, description and icon, then headings, a :::note callout and a ::::tabs block as plain text.](/docs-assets/guides/editor/editor-markdown.webp)

The Markdown is the same format docs.markdrop.in is written in: callouts are `:::note`, steps are `::::steps`, tabs are `::::tabs` and so on. Anything the visual editor can't show as a block, it keeps exactly as written and labels "Edit it in Markdown mode". Switching back and forth changes nothing.

**Preview** opens a quick look at the draft. Callouts, steps and tabs render fully on the published guide.

## The slash menu

Type `/` on a new line, or after a space, to insert a block. An empty line says **Type / for blocks**. Keep typing to filter, like `/tip` or `/code`, then press Enter. (It doesn't open inside code blocks and tables.)

::clip{src="/docs-assets/guides/editor/editor-slash-callout" alt="In the Invite your team page, a new line, typing /tip, choosing Tip callout, and typing a sentence into the new tip."}

You can also use the **+** in the margin: beside the empty line you're on, or beside any block you point at (**Add a block below**). Drag the grip beside a block to move it, or click it for **Move up**, **Move down**, **Duplicate** and **Delete**. Alt + Shift + ↑ or ↓ moves the block with the keyboard.

## Formatting

Select text for the formatting bar: **Bold**, **Italic**, **Inline code**, **Link**, **Turn into heading** (text, heading, subheading or small heading), **Turn into list** (bulleted, numbered or a quote) and **More formatting** (strikethrough and keyboard key). Then **Ask AI** and **Comment**.

A link can be a page of the guide (`/guides/alert-rules`), a section (`#install`) or any `https://` address.

## Ask AI

Select a sentence or a few paragraphs, choose **Ask AI**, then:

- **Improve the writing**: clearer and more direct, about the same length
- **Make it shorter**: about half, keeping the facts, steps and warnings
- **Fix spelling and grammar**: nothing else changes
- **Translate…**: pick a language (31 of them; type to filter)

The answer appears under the text as a suggestion, and the passage it would replace stays highlighted. Nothing changes until you choose **Accept**. **Try again** asks for another version, and **Discard** (or Esc) drops it. An accepted suggestion is one step in the undo history, so ⌘ Z (Ctrl Z) brings your words back.

AI help keeps links, code, Markdown and blocks like callouts as they are, and it never follows instructions written in your text. Still, read a suggestion before you accept it.

Limits:

- A selection can be up to 6,000 characters.
- Each person can use AI help 50 times a day (UTC).
- AI help shares the guide's AI budget with its readers' [Ask AI](/guides/ask-ai): every use counts towards the same monthly allowance. When it's used up, AI help says "This guide's AI budget for the month is used up" until the 1st (UTC).

Only the selection and the action are sent to the model, and nothing of either is kept: Markdrop records that AI help was used (which action, how long the text was, the cost), never the text or the answer.

## Find and replace

⌘ F (Ctrl F on Windows and Linux) opens **Find and replace** on the page, in Visual and Markdown mode, with the selected text as the search. **Aa** matches case, **ab** matches whole words only. Enter goes to the next match and Shift + Enter to the previous one. The arrow beside the search shows **Replace with**: **Replace** changes the current match, **Replace all** every match (⌘ Enter in that box). Esc closes it. The status bar under the page has the same button, beside the word count and reading time.

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

Under the checks, **On this page** lists the page's headings and subheadings, as readers see them. The section you're reading is marked; choose one to jump to it.

## Comments

Select text and choose **Comment** to ask a question or suggest a change about it, then **Comment** again (or ⌘ Enter). Comments are for the guide's Editors, Reviewers and Admins, and they never reach readers. **Comment on selection** in the **Comments** tab works on a page someone else is editing too.

Commented text is highlighted in the page; choose it to open its thread. In a thread you can **Reply**, **Resolve** (it moves to **Resolved**, where **Reopen** brings it back) and, for your own comments (or as an Admin), **Delete**. The tab's count is the open comments, and the tree shows each page's. There are no notifications: open comments show as counts.

## Who else is here

When other people have the guide's editor open, their pictures are in the header with "Asha is here". Point at one to see which page they're on and whether they're editing it; choose it to open that page. The panel's footer says who last edited this page and who is editing which page right now, with **Version history**.

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
| **Cards** | Links to other pages, with an icon each. |
| **Details** | A collapsible section, good for FAQs. |
| **Image** | An image with a caption, alt text and an optional dark-theme version. |
| **Code** | Code with a language, an optional title and a copy button. |
| **Table** | Rows and columns, with a header row. |
| **Bulleted list**, **Numbered list**, **Checklist** | Lists. |
| **Quote**, **Divider**, **Keyboard key** | A quotation, a horizontal line, and keys like Ctrl K. |
| **Math** | A LaTeX formula, previewed as you type. |

The menu also lists **Video**, **Clip**, **Embed** and **API endpoint**. They come from the engine Markdrop's own docs use. On a guide, an embedded page shows as a link card, and an API endpoint shows as a card with the method and path you type. With an [API reference](/guides/api-reference), the block offers your file's endpoints, and the card links to the endpoint's page.

## Keyboard shortcuts

Press `?` (when you're not typing) or **Shortcuts** in the status bar for the list. On Windows and Linux, use Ctrl for ⌘ and Alt for ⌥.

| Shortcut | Does |
| --- | --- |
| :kbd[⌘ B], :kbd[⌘ I], :kbd[⌘ E] | Bold, italic, inline code |
| :kbd[⌘ ⇧ S], :kbd[⌘ ⇧ K] | Strikethrough, keyboard key |
| :kbd[⌘ K] | Link (with text selected) |
| :kbd[⌘ ⌥ 2], :kbd[⌘ ⌥ 3] | Heading, subheading |
| :kbd[⌘ ⇧ 8], :kbd[⌘ ⇧ 7], :kbd[⌘ ⇧ B] | Bulleted list, numbered list, quote |
| :kbd[⌘ ⌥ C] | Code block |
| :kbd[/] | The block menu |
| :kbd[Alt ⇧ ↑], :kbd[Alt ⇧ ↓] | Move the block up or down |
| :kbd[⇧ Enter] | A line break (in a table, the next row) |
| :kbd[⌘ F] | Find and replace |
| :kbd[⌘ Z], :kbd[⌘ ⇧ Z] | Undo, redo |
| :kbd[⌘ Enter] | Send a comment or reply |

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
