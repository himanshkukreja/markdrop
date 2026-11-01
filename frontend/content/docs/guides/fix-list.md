---
title: "Fix list: what to fix next"
nav: Fix list
description: One ranked list of what to fix next in your guide, from what readers and AI agents run into, each with the evidence and an AI-drafted fix.
updated: 2026-11-02
prerequisites: [/guides/insights]
keywords: [fix list, content gaps, what to fix, drop-off, read depth, readers leave, searches with no results, unanswered questions, not helpful, video retention, pdf, broken links, stale pages, ai agents, llms.txt, mcp, ai drafted fix, privacy]
---

The **Fix list** turns what your readers run into into one ranked list of things to fix: the section where they give up, the search that finds nothing, the question nobody answers, the moment a video loses them, the link that goes nowhere. Each item shows its evidence and can draft a concrete fix for you to review in the editor.

Open a guide and choose **Fix list** in the bar at the top. The number beside it is how many items are open. It's built from [Insights](/guides/insights), so it's on for every guide with Insights on, with nothing to set up.

![Acme's Fix list: 15 to fix, 2 high impact, 1 in progress and 1 fixed, 1,464 agent reads next to 1,059 readers. The top items: readers leave at "Install the CLI" (131 readers), Quickstart marked not helpful, API keys not updated in 8 months, Product tour loses most viewers at 0:40, and a page agents can't use. Beside them, Needs more readers and AI agents.](/docs-assets/guides/fix-list/fixlist-overview.webp)

## What it finds

| Item | What it means |
| --- | --- |
| **Readers leave here** | Many more readers stop at one section of a page than at the rest of it. |
| **Searches with no results** | What readers type in the search box and find nothing for, with the wordings that mean the same thing grouped together. |
| **Ask AI couldn't answer** | Questions [Ask AI](/guides/ask-ai) had no answer for in your pages, grouped the same way. |
| **Marked not helpful** | A page most readers who voted said didn't help, with their comments. |
| **Video drop-off** | The moment a video loses most of its viewers: "loses most viewers at 0:42". |
| **PDF drop-off** | The page of an embedded PDF where most readers stop. |
| **Broken links** | Links in your pages to a page that doesn't exist, and addresses in your guide readers hit that don't exist. |
| **Agents find nothing** | What AI assistants search your docs for through its [MCP server](/guides/what-readers-get#for-ai-tools) and find nothing. |
| **Hard for agents** | A page AI agents read a lot that is hard for them to use: long with no headings, mostly images or video, or hidden from llms.txt. |
| **Stale pages** | A page many readers open that nobody has edited in six months. |
| **Long, heavy pages** | A very long or image-heavy page that people read. |

The list is checked again every day, and when you open it after a day without a check. Editors can choose **Check now**.

## How items are ranked

Each item has an impact: the readers it affects (the readers who left at that section, the searches that found nothing, the viewers lost), times how serious that kind of problem is, times how recent it is (evidence from two weeks ago counts half). The biggest impact comes first, marked **High impact**, **Medium** or **Low**.

Nothing is flagged on a handful of visits. Each kind of item needs a minimum before it shows (a page needs 25 measured readers before its sections are judged, a video 8 plays), and each item says how sure it is: **Confident**, **Likely** or **Early signal**. Pages and videos still collecting show under **Needs more readers**, with how far along they are.

Filter by status (**To fix**, **Fixed**, **Dismissed**, **All**), by kind of item, or by page.

## The evidence

Choose an item to see why it's there. A section drop shows how far readers got down the page, section by section, with the one where they leave marked. A video shows how many viewers are still watching at each moment. Searches and questions show the wordings readers used, and "not helpful" pages their comments.

![The drawer for "Readers leave at Install the CLI": High impact, Open, Confident; 42% of 310 measured readers stopped there against about 4% per section elsewhere; a bar per section from the introduction to the end of the page with Install the CLI in red; then the suggested fix as a line-by-line change, with Open in editor.](/docs-assets/guides/fix-list/fixlist-drawer.webp)

![The drawer for a video: "Product tour loses most viewers at 0:40", played 152 times, with a chart of viewers still watching over its 1:40 and a dashed line at 0:40 where it falls.](/docs-assets/guides/fix-list/fixlist-video.webp)

## Draft a fix

In an item, choose **Draft a fix** (its label says what it does: **Rewrite the section**, **Write an answer**, **Fix the link**). The AI reads the evidence and the page and proposes a concrete edit:

- a rewrite of the section readers leave, or of the page readers marked not helpful, using their comments;
- a new section at the end of the page that answers what readers searched for or asked, or the outline of a new page when nothing covers it;
- the broken link pointed at the page that looks like the right one;
- for a stale or long page, a list of what to check or how to split it.

You see it as a change, line by line. Choose **Open in editor**: the page opens with the fix offered as a suggestion over the section it rewrites. **Accept** puts it in the page, where you can keep editing; **Discard** drops it. A new page outline has **Create the page** instead. Where the AI doesn't know a fact, it leaves a placeholder in square brackets for you to fill in.

![The editor with the suggested fix offered over the Install the CLI section: the section highlighted, and a card with the new Markdown, Accept and Discard, and the note that it's marked fixed when you publish.](/docs-assets/guides/fix-list/fixlist-editor.webp)

Nothing is published until you publish. Once you accept a fix, the item is **In progress**; the next publish that changes that page marks it **Fixed**.

Each draft uses one of the guide's monthly AI uses, shared with Ask AI and the editor's AI help ([limits](/account/limits)). A link fix and a hidden page's advice don't use any. A draft stays on the item, so opening it again costs nothing; **Draft again** asks for a new one.

## Work through the list

- **Start** marks an item **In progress**.
- **Mark fixed** closes it. If the problem comes back (readers keep leaving there in the days after, or the next publish still has the broken link), it reopens and says **Came back**.
- **Dismiss** asks why: **Not a problem**, **Won't fix**, **Duplicate** or something else, with an optional note. A dismissed item stays dismissed.
- An open item that isn't seen for a week closes itself.

| Role | Can |
| --- | --- |
| Viewer | See the Fix list |
| Editor, Reviewer, Admin | Draft fixes, check now, start, mark fixed, dismiss and reopen |

On the [Guides home](/guides/overview#your-guides), a live guide's card shows how many things it has to fix.

## Before there's anything to fix

A guide with no readers yet says what the list watches. Choose **See a sample Fix list** to see it with fictional data, so you know what to expect before traffic arrives.

![A live guide with no readers yet: Watching, "Nothing to fix yet", See a sample Fix list beside three sample items, and What it watches: readers leave here, searches with no results, Ask AI couldn't answer, marked not helpful, video drop-off, broken links, agents find nothing and stale pages.](/docs-assets/guides/fix-list/fixlist-empty.webp)

## AI agents

Assistants like ChatGPT, Claude and Perplexity, and the tools your readers use, read docs too, often more than people do. The Fix list counts them apart from readers, never as one, and shows them in **AI agents**: how many reads, from which assistants, and how (pages, Markdown, llms.txt, MCP).

![AI agents: 1,464 agent reads in 30 days next to 1,059 readers, Claude 58%, ChatGPT 25%, Perplexity 11%, Gemini 4%, Other tool 2%, and llms.txt 318, Markdown 664, MCP 196, Pages 286. Above it, Needs more readers: Invite your team, 18 of 25 reads.](/docs-assets/guides/fix-list/fixlist-agents.webp)

An agent read is a page loaded by a known AI agent, or any request for a page's Markdown version, llms.txt or the docs MCP server. Kept: the page, how it was read, and the assistant's family (like "Claude" or "Other tool"). Not kept: its address or its full user agent.

## What it collects

The Fix list follows the same rules as [Insights](/guides/insights#whats-collected-and-what-isnt), and some stricter ones:

| Kept | Never kept |
| --- | --- |
| How far down a page a reader got (which section), and how long the page was open | Anything that identifies a reader, not even the daily visitor code |
| Which parts of a docs video or an embedded video were played, and the furthest page of an embedded PDF | What a reader typed, other than searches and Ask AI questions Insights already keeps |
| Which code block's Copy was used | Cookies, or anything stored in the browser |
| Addresses in your guide that don't exist, and the guide page that linked there | Where readers came from outside your guide |
| AI agents' reads (page, how, which assistant) and their MCP searches that found nothing | Agents' addresses or full user agents |

When a reader's browser sends **Do Not Track** or **Global Privacy Control**, none of this is sent at all. A page view sends one small request, when the reader leaves the page. Turning Insights off stops it, and deleting Insights' data deletes the Fix list too.
