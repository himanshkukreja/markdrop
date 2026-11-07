---
title: AI in pages
nav: AI in pages
description: Rewrite, draft, summarize and translate pages with AI, turn notes into a page, and let readers ask a page questions. Who can use it, what's sent, the limits.
updated: 2026-11-05
prerequisites: [/pages/overview]
keywords: [ai, claude, view mode, edit mode, ✦ ask, insert, anthropic, ask ai, ask this page, summarize, summary, translate, translation, action items, to-do, notes, alt text, title, icon, /ai, cmd j, ctrl j, workspace ai, privacy, training, limits, cover, auto cover, automatic cover]
---

Pages have AI built in. If you can edit a page, you can rewrite a passage, draft a section, summarize the page, find its action items, translate it and get alt text for its images. If you can only read a page, you can ask it questions. Every AI result is a suggestion: nothing changes on the page until you accept it.

Pages open in [View mode](/pages/overview#view-and-edit), so the writing tools are in the editor: choose **Edit** (or press **E**) first. **✦ Ask** works in both modes.

Pages are in beta, and so is AI in pages. What powers it and what's sent: [AI and your data](/security/ai-and-your-data).

## What you can do

| Feature | Who | Where |
| --- | --- | --- |
| [Rewrite a selection](#rewrite-a-selection) | Editors | **Ask AI**, **⌘ J** |
| [Draft with /ai](#draft-with-ai) | Editors | `/ai`, **⌘ J** |
| [Start from notes](#start-a-page-from-notes) | Editors | **New page** |
| [Find action items](#find-action-items) | Editors | **⋯** menu in the editor, **Ask AI** |
| [Summarize a page](#summarize-a-page) | Editors | **⋯** menu in the editor |
| [Ask this page](#ask-this-page) | Everyone signed in who can open it | **✦ Ask** in the top bar, **⌘ J** |
| [Title and icon](#suggest-a-title-description-and-icon) | Editors | **⋯** menu in the editor |
| [Translate a page](#translate-a-page) | Editors | **⋯** menu in the editor |
| [Alt text](#alt-text-for-images) | Editors | Adding an image |
| [Cover](#pick-a-cover) | Anyone making a page | Automatic, and **Pick for me** |

## Rewrite a selection

Select some text and choose **Ask AI** in the formatting bar, or press **⌘ J** (**Ctrl J** on Windows and Linux). On a phone, **Ask AI** is in the toolbar above the keyboard. Then choose:

- **Improve writing**: clearer and more direct, about the same length.
- **Make shorter**: keeps the facts, steps and warnings.
- **Fix spelling & grammar**: nothing else changes.
- **Change tone**: professional, friendly or concise.
- **Translate**: pick a language, or type to filter the list.
- **Turn into checklist** or **Turn into table**.
- **Explain**: a plain-language explanation of the selection.
- **Find action items**: see [Find action items](#find-action-items).

The result appears as a suggestion, drawn as the blocks it would become, with the passage it replaces highlighted. Choose **Accept** to use it, **Try again** for another version, or **Discard** (or **Esc**) to drop it. An accepted suggestion is one step in the undo history, so **⌘ Z** brings your words back.

AI keeps links, mentions, embeds, code and the page's own Markdown as they are. A selection can be up to 12,000 characters.

![A selected paragraph with the Ask AI menu open from the formatting bar: Improve writing, Make shorter, Fix spelling & grammar, Change tone, Translate, Turn into checklist, Turn into table, Find action items and Explain.](/docs-assets/pages/ai/ai-menu.webp)

## Draft with /ai

On an empty line, type `/ai`, press **⌘ J**, or press **Space**. Say what you want, such as "write an intro" or "add a rollout checklist", and press **Enter**. The draft streams in as a suggestion in the page's own blocks, written with the rest of the page in mind, with **Accept**, **Try again** and **Discard**.

## Start a page from notes

Choose **New page**, then **Start from notes**. Paste your notes (meeting notes, a brain dump, bullet points), pick a shape such as **Meeting notes** or **Project brief**, or **Auto** to let AI choose, and choose **Draft the page**. The draft streams in beside your notes, with that shape's headings. Nothing is created until you choose **Create page**; **Draft again** asks for another version. Notes can be up to 40,000 characters.

## Find action items

Choose **Find action items** in the page's **⋯** menu while you edit, for the whole page, or in **Ask AI** for a selection. AI lists the to-dos it finds as a to-do list. When a to-do names someone in the page's workspace, it gets a person chip, and a date becomes a date chip. The list is a suggestion you accept or discard.

## Summarize a page

While you edit, choose **Summarize page** in the page's **⋯** menu. A short summary, a note titled **Summary**, is suggested at the top of the page. Accept it and it's part of the page, for every reader. Markdrop never adds a summary for readers on its own.

## Ask this page

Anyone signed in who can open a page can ask it questions with [Ask](/workspaces/ask-markdrop), the one assistant in Markdrop. Choose **✦ Ask** in the page's top bar, or press **⌘ J** when you're not typing in the page. It opens beside the page (a sheet from the bottom on a phone), on **This page**.

- Start with a suggestion, **Summarize this doc**, **What did we decide about this in meetings?** or **What's still open here?**, or type your own question and press **Enter** (**Shift Enter** for a new line).
- Ask knows which section you're in and what you selected: select a paragraph and ask "Is this still true?".
- Answers stream in with numbered sources: the page itself, and the meetings and documents they also used. Select a number to see what the source says, and open it.
- Ask follow-ups in the same conversation. **Stop** ends an answer early, and **New chat** starts again. The conversation is kept when you close the panel, and follows you to other pages.

In a workspace page, **This page** answers from the page first, then what the workspace's meetings decided about it (with the meeting, its date and a link to the moment: "When did we decide this?"), then the workspace's other documents. See [Meeting memory while writing](/pages/meeting-memory#ask-the-page-with-your-meetings). Switch to **Meetings**, **Workspace** or **Everything** to ask more widely.

If you can edit the page, **Insert** under an answer puts it into the page after the line where your cursor is, with its sources as links. In View mode, **Insert** switches the page to **Edit** with the answer at the end of the section you were reading. Nothing goes into the page unless you choose **Insert**.

AI can be wrong, so check what matters on the page itself. Asking counts towards your **AI search** limit; see [AI limits](/workspaces/ask-markdrop#ai-limits).

**✦ Ask** works on a workspace's [own domain](/workspaces/custom-domain) too, once you're [signed in there](/workspaces/sign-in-on-your-domain). Visitors who aren't signed in don't see it.

## Suggest a title, description and icon

When a new page is first saved without a title, a chip under the title suggests one, with an icon and a one-line description: "Use title ‘Q3 launch plan’ · 🚀 · description". Choose it to use them all, or dismiss it. To ask at any time, choose **Suggest title & icon** in the page's **⋯** menu while you edit.

## Translate a page

While you edit, choose **Translate…** in the page's **⋯** menu, pick a language, then **Translate to** that language. Markdrop makes a new page next to this one, called "Title (Español)" for Spanish, and shows its progress section by section. When it's done, choose **Open the copy**.

- The copy has the same blocks, embeds, images and page options, and it sits next to the original, so it follows the same access.
- Only the text is translated. Links, mentions, embeds, code and the page's Markdown stay exactly as they were, and Markdrop checks that the copy has the same structure before saving it.
- The original page doesn't change.

A long page can take a minute. You can translate into 31 languages.

## Alt text for images

When you upload an image to a page, AI describes it and fills in its alt text, marked **Alt text suggested**. Keep it or edit it: the mark goes once you change it. Alt text is what screen readers read out, and what shows when the image can't load.

## Pick a cover

A new page gets one of Markdrop's covers, chosen for what it's about: see [Automatic covers](/pages/overview#automatic-covers). AI makes that choice when it's on for the page, from the page's title and its first lines; **Pick for me** in the cover picker asks the same question again. When AI is off for the workspace, over a limit or unavailable, the cover is matched on the page's words, and nothing is sent.

## Keyboard shortcuts

| Shortcut | What it does |
| --- | --- |
| **⌘ J** | In the text you're editing: with text selected, **Ask AI** for the selection, otherwise draft with `/ai` at the caret. Anywhere else: open [Ask](/workspaces/ask-markdrop) |
| **Space** on an empty line | Draft with `/ai` |
| **Enter** | Run the prompt, or ask the question |
| **Esc** | Discard a suggestion, or close Ask |

On Windows and Linux, use **Ctrl** where this page says **⌘**. All of the page editor's shortcuts are in [Keyboard shortcuts](/pages/keyboard-shortcuts).

## Who can use AI

- **People who can edit a page** use the writing tools: rewriting, `/ai`, notes, action items, summaries, title suggestions, translation and alt text.
- **Signed-in readers** of a page can use **Ask**. Anyone who can open the page counts, whatever their role.
- **Visitors who aren't signed in** don't get AI.
- **End-to-end encrypted documents** never use AI. Nothing from them is sent anywhere.
- Pages outside a workspace always have AI.

## Turn AI off for a workspace

AI is on for every workspace by default. Admins can turn it off on the **Advanced** tab of the workspace's settings, with **AI features**. When it's off, the workspace's pages have no AI at all: the AI options are gone or say "AI is off for this workspace", and readers don't see **Ask**. Turn it on again at any time.

## What's sent

When you use AI, Markdrop sends the AI only what that request needs:

- the text you selected, or the page's text (for a long page, only the sections nearest what you're doing), and your prompt or question;
- the text of Markdrop items the page embeds, but only items the person asking can open;
- for alt text, the image;
- for a page's cover, its title and its first 1,500 characters or so, with the list of Markdrop's covers. The answer is just the cover's name.
- for [AI search](/workspaces/search#ask-ai), your question and short excerpts of the matching items you can open (never an encrypted item, and only the title of a password-protected one).

Markdrop keeps a usage record for each request, never the page's text, your prompt, the question or the answer, and nothing sent is used to train models. See [AI and your data](/security/ai-and-your-data) for which AI this is and what else is kept.

AI treats the page's text as content to work on, never as instructions, so a page can't tell AI to do something else.

## Limits

AI in pages is free during the beta, with fair-use limits:

- Each person can make 30 AI requests a minute and 300 a day.
- A question can be up to 2,000 characters, a selection up to 12,000 and notes up to 40,000.
- AI also has fair-use limits across everyone during the beta. If one is reached, AI pauses with "AI limit reached for today. Try again tomorrow." until the next day (UTC).

When you hit a limit, AI says so and which one. The rest of the page works as usual.

## In Markdrop Guides

The Guides page editor has the same writing tools: **Ask AI** on a selection (and **⌘ J**), and an **AI** menu in the status bar with **Ask AI to write…**, **Summarize page**, **Find action items** and **Suggest title & description**. They count toward the guide's monthly AI allowance. Readers of a guide have their own [Ask AI](/guides/ask-ai). See [The page editor](/guides/editor#ask-ai).

## From your AI app

Three [MCP tools](/ai/tools#pages) bring this to Claude, ChatGPT and other AI apps connected to Markdrop: `translate_page` makes a translated copy of a page, `summarize_page` returns a summary or adds it to the top of the page, and `suggest_page_meta` suggests a title, description and icon. They use Markdrop's AI with the same limits.

## Related

- [Meeting memory while writing](/pages/meeting-memory)
- [Pages and the block editor](/pages/overview)
- [Keyboard shortcuts](/pages/keyboard-shortcuts)
- [Embed and mention Markdrop items](/pages/embed-and-mention)
- [Privacy at Markdrop](/security/privacy)
