---
title: Write in the editor
nav: The editor
description: Docs Studio's page editor, visual or Markdown. The slash menu, every block, images with dark versions, the page header, autosave, locks and conflicts.
updated: 2026-10-31
prerequisites: [/docs-studio/create-a-site]
keywords: [editor, visual editor, markdown, slash menu, blocks, callout, steps, tabs, cards, code block, image, dark mode image, autosave, lock, conflict, preview]
---

Open a site and its **Pages** tab is the editor: the page tree on the left, the page in the middle, and the page's settings and history on the right.

![The Docs Studio editor on Acme's Quickstart page: the page tree with groups Getting started, Guides, Reference and Help, the page with its icon, title, description, a note callout and tabs, and on the right the page's Address, Show in the sidebar, Icon and History.](/docs-assets/docs-studio/editor/editor-overview.webp)

Only people with the Editor, Reviewer or Admin role can edit. Viewers see the same screen with **View only** in the bar. See [Members and roles](/docs-studio/members-and-roles).

## The page header

Above the text, every page has:

- an **icon**, shown beside the page in the sidebar
- the **title** (**Page title**), the page's heading and its name in the sidebar and search
- a **description**: one sentence shown under the title and in search results

## Visual or Markdown

The **Visual** / **Markdown** switch in the bar changes how you edit, not what's saved. **Markdown** shows the page as the file it is: a front matter block with `title`, `description` and `icon`, then the body. Docs Studio remembers your choice in this browser.

![The Quickstart page in Markdown mode: front matter with title, description and icon, then headings, a :::note callout and a ::::tabs block as plain text.](/docs-assets/docs-studio/editor/editor-markdown.webp)

The Markdown is the same format docs.markdrop.in is written in: callouts are `:::note`, steps are `::::steps`, tabs are `::::tabs` and so on. Anything the visual editor can't show as a block, it keeps exactly as written and labels "Edit it in Markdown mode".

**Preview** opens a quick look at the draft. Callouts, steps and tabs render fully on the published site.

## The slash menu

Type `/` on a new line, or after a space, to insert a block. Keep typing to filter, like `/tip` or `/code`, then press Enter. (It doesn't open inside code blocks and tables.)

::clip{src="/docs-assets/docs-studio/editor/editor-slash-callout" alt="In the Invite your team page, a new line, typing /tip, choosing Tip callout, and typing a sentence into the new tip."}

You can also use the **+** beside any block (**Add a block below**), or drag the grip beside it to move it. Click the grip for **Move up**, **Move down**, **Duplicate** and **Delete**. Alt + Shift + ↑ or ↓ moves the block with the keyboard.

Select text for the formatting bar: bold, italic, strikethrough, inline code, keyboard key, link, heading and subheading. A link can be a page of the site (`/guides/alert-rules`), a section (`#install`) or any `https://` address.

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

The menu also lists **Video**, **Clip**, **Embed** and **API endpoint**. They come from the engine Markdrop's own docs use. On a Docs Studio site, an embedded page shows as a link card, and an API endpoint has no OpenAPI file to point at yet, so it shows as a plain card.

## Images

Add an **Image** block, then **Upload an image**, drop one onto it, or paste an image address. A file can be up to 25 MB. Select the image for its tools:

- **Alt text**: what the image shows, for people who can't see it. "(missing)" means there's none yet.
- **Add a caption** under the image.
- **Replace** uploads a new image in its place.
- **Add dark version**: an image to show instead when the reader's site is in the dark theme, like a screenshot taken in dark mode. Readers see the one that matches their theme.

![An image block selected in the editor, with Alt text, Replace, Add dark version and a delete button under it.](/docs-assets/docs-studio/editor/image-block.webp)

## Saving

There's no Save button. Drafts save themselves a moment after you stop typing, and the bar says where the draft is: **Draft · editing**, **Saving…**, then **Draft · saved** with the time. **Not saved · retry** means the save didn't go through: choose it to try again. Every save is a version in the page's [history](/docs-studio/history).

Saved drafts aren't public. Readers see a change after the next [publish](/docs-studio/publishing). A dot beside a page in the tree marks unpublished changes.

## One editor per page

While you have a page open, it's yours to edit. Anyone else who opens it sees **Read only**, a lock beside the page in the tree with your name, and a note that it opens for editing when you're done. Leaving the page lets go of it. If your browser closes without leaving, the page frees itself two minutes later.

![Acme's Connect Postgres page opened by Riya while Alex has it: the banner "Alex Chen is editing this page" with Take over, Read only in the bar, and a lock with Alex's name beside the page in the tree.](/docs-assets/docs-studio/editor/page-locked.webp)

A Docs Studio admin can choose **Take over**. The other person's unsaved typing is lost, and they see a banner saying who took over the page, with **Copy my text** (their text to the clipboard), **Load their version** and, for admins, **Take it back**.

## When someone saved first

If the page was saved by someone else since you opened it, Docs Studio stops and asks, in **Someone saved a newer version**:

- **Keep mine** saves your text as the newest version. Theirs stays in the history.
- **Use their version** drops your unsaved changes.
- **Copy my text** puts your text on the clipboard first.
