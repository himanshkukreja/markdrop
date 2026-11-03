---
title: AI in pages
nav: AI in pages
description: Rewrite, draft, summarize and translate pages with AI, turn notes into a page, and let readers ask a page questions. Who can use it, what's sent, the limits.
updated: 2026-11-04
prerequisites: [/pages/overview]
keywords: [ai, claude, anthropic, ask ai, ask this page, summarize, summary, translate, translation, action items, to-do, notes, alt text, title, icon, /ai, cmd j, ctrl j, workspace ai, privacy, training, limits]
---

Pages have AI built in. If you can edit a page, you can rewrite a passage, draft a section, summarize the page, find its action items, translate it and get alt text for its images. If you can only read a page, you can ask it questions. Every AI result is a suggestion: nothing changes on the page until you accept it.

Markdrop's AI uses Anthropic's Claude. Pages are in beta, and so is AI in pages.

## What you can do

| Feature | Who | Where |
| --- | --- | --- |
| [Rewrite a selection](#rewrite-a-selection) | Editors | **Ask AI**, **⌘ J** |
| [Draft with /ai](#draft-with-ai) | Editors | `/ai`, **⌘ J** |
| [Start from notes](#start-a-page-from-notes) | Editors | **New page** |
| [Find action items](#find-action-items) | Editors | **⋯** menu, **Ask AI** |
| [Summarize a page](#summarize-a-page) | Editors | **⋯** menu |
| [Ask this page](#ask-this-page) | Signed-in readers | **✦ Ask** |
| [Title and icon](#suggest-a-title-description-and-icon) | Editors | **⋯** menu |
| [Translate a page](#translate-a-page) | Editors | **⋯** menu |
| [Alt text](#alt-text-for-images) | Editors | Adding an image |

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

## Draft with /ai

On an empty line, type `/ai`, press **⌘ J**, or press **Space**. Say what you want, such as "write an intro" or "add a rollout checklist", and press **Enter**. The draft streams in as a suggestion in the page's own blocks, written with the rest of the page in mind, with **Accept**, **Try again** and **Discard**.

## Start a page from notes

Choose **New page**, then **Start from notes**. Paste your notes (meeting notes, a brain dump, bullet points), pick a shape such as **Meeting notes** or **Project brief**, or **Auto** to let AI choose, and choose **Draft the page**. The draft streams in beside your notes, with that shape's headings. Nothing is created until you choose **Create page**; **Draft again** asks for another version. Notes can be up to 40,000 characters.

## Find action items

Choose **Find action items** in the page's **⋯** menu for the whole page, or in **Ask AI** for a selection. AI lists the to-dos it finds as a to-do list. When a to-do names someone in the page's workspace, it gets a person chip, and a date becomes a date chip. The list is a suggestion you accept or discard.

## Summarize a page

Choose **Summarize page** in the page's **⋯** menu. A short summary, a note titled **Summary**, is suggested at the top of the page. Accept it and it's part of the page, for every reader. Markdrop never adds a summary for readers on its own.

## Ask this page

Anyone signed in who can open a page can ask it questions. Choose **✦ Ask** at the bottom right of the page. It opens a panel beside the page (a sheet from the bottom on a phone).

- Start with a suggestion, **Summarize this page**, **What are the key decisions?** or **What's still open?**, or type your own question and press **Enter** (**Shift Enter** for a new line).
- Answers stream in and link to the sections they come from. Choose a link, or a section under **Sections**, to scroll to that heading; it's highlighted for a moment.
- Ask follow-ups: your last six questions and answers go with each new question. **Stop** ends an answer early, and **Clear** starts again. Closing the panel keeps the conversation until you leave the page.

Answers use only this page and the Markdrop items it embeds that you can open yourself. An embedded item you can't open is never read for your answer. AI can be wrong, so check what matters on the page itself.

**Ask** works on a workspace's [own domain](/workspaces/custom-domain) too, once you're [signed in there](/workspaces/sign-in-on-your-domain). Visitors who aren't signed in don't see it.

## Suggest a title, description and icon

When a new page is first saved without a title, a chip under the title suggests one, with an icon and a one-line description: "Use title ‘Q3 launch plan’ · 🚀 · description". Choose it to use them all, or dismiss it. To ask at any time, choose **Suggest title & icon** in the page's **⋯** menu.

## Translate a page

Choose **Translate…** in the page's **⋯** menu, pick a language, then **Translate to** that language. Markdrop makes a new page next to this one, called "Title (Español)" for Spanish, and shows its progress section by section. When it's done, choose **Open the copy**.

- The copy has the same blocks, embeds, images and page options, and it sits next to the original, so it follows the same access.
- Only the text is translated. Links, mentions, embeds, code and the page's Markdown stay exactly as they were, and Markdrop checks that the copy has the same structure before saving it.
- The original page doesn't change.

A long page can take a minute. You can translate into 31 languages.

## Alt text for images

When you upload an image to a page, AI describes it and fills in its alt text, marked **Alt text suggested**. Keep it or edit it: the mark goes once you change it. Alt text is what screen readers read out, and what shows when the image can't load.

## Keyboard shortcuts

| Shortcut | What it does |
| --- | --- |
| **⌘ J** | With text selected: **Ask AI** for the selection. Otherwise: draft with `/ai` at the caret |
| **Space** on an empty line | Draft with `/ai` |
| **Enter** | Run the prompt, or ask the question |
| **Esc** | Discard a suggestion, or close the Ask panel |

On Windows and Linux, use **Ctrl** where this page says **⌘**. All of the page editor's shortcuts are in [Keyboard shortcuts](/pages/keyboard-shortcuts).

## Who can use AI

- **People who can edit a page** use the writing tools: rewriting, `/ai`, notes, action items, summaries, title suggestions, translation and alt text.
- **Signed-in readers** of a page can use **Ask**. Anyone who can open the page counts, whatever their role.
- **Visitors who aren't signed in** don't get AI.
- **End-to-end encrypted documents** never use AI. Nothing from them is sent anywhere.
- Pages outside a workspace always have AI.

## Turn AI off for a workspace

AI is on for every workspace by default. Admins can turn it off on the **Advanced** tab of the workspace's settings, with **AI features**. When it's off, the workspace's pages have no AI at all: the AI options are gone or say "AI is off for this workspace", and readers don't see **Ask**. Turn it on again at any time.

## What's sent to Anthropic

When you use AI, Markdrop sends Anthropic only what that request needs:

- the text you selected, or the page's text (for a long page, only the sections nearest what you're doing), and your prompt or question;
- the text of Markdrop items the page embeds, but only items the person asking can open;
- for alt text, the image.

Markdrop keeps a usage record for each request (who, which feature, the number of tokens and the cost), never the page's text, your prompt, the question or the answer. Anthropic doesn't use data sent through its commercial API to train its models by default; see [Anthropic's commercial terms](https://www.anthropic.com/legal/commercial-terms). The [privacy page](/security/privacy) has the rest of what Markdrop keeps.

AI treats the page's text as content to work on, never as instructions, so a page can't tell AI to do something else.

## Limits

AI in pages is free during the beta, with fair-use limits:

- Each person can make 30 AI requests a minute and 300 a day.
- A question can be up to 2,000 characters, a selection up to 12,000 and notes up to 40,000.
- Markdrop has a daily limit on AI across everyone during the beta. If it's reached, AI pauses with "AI limit reached for today. Try again tomorrow." until the next day (UTC).

When you hit a limit, AI says so and which one. The rest of the page works as usual.

## In Markdrop Guides

The Guides page editor has the same writing tools: **Ask AI** on a selection (and **⌘ J**), and an **AI** menu in the status bar with **Ask AI to write…**, **Summarize page**, **Find action items** and **Suggest title & description**. They count toward the guide's AI budget. Readers of a guide have their own [Ask AI](/guides/ask-ai). See [The page editor](/guides/editor#ask-ai).

## From your AI app

Three [MCP tools](/ai/tools#pages) bring this to Claude, ChatGPT and other AI apps connected to Markdrop: `translate_page` makes a translated copy of a page, `summarize_page` returns a summary or adds it to the top of the page, and `suggest_page_meta` suggests a title, description and icon. They use Markdrop's AI with the same limits.

## Related

- [Pages and the block editor](/pages/overview)
- [Keyboard shortcuts](/pages/keyboard-shortcuts)
- [Embed and mention Markdrop items](/pages/embed-and-mention)
- [Privacy at Markdrop](/security/privacy)
