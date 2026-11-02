---
title: Insights for your guide
nav: Insights
description: How readers use your published guide. Views, top pages, searches with no results, Ask AI questions and page feedback, with no cookies or personal data.
updated: 2026-11-02
prerequisites: [/guides/publishing]
keywords: [insights, analytics, page views, visitors, top pages, referrers, searches, no results, feedback, was this helpful, ask ai questions, privacy, cookies, gdpr, do not track]
---

**Insights** shows how readers use your published guide: which pages they open, where they come from, what they search for, what they ask Ask AI and whether a page helped them. Open a guide and choose **Insights** in the bar at the top. It's on for every guide, with no setup and no code to add.

Insights is privacy-first: no cookies, nothing stored in readers' browsers, no personal data, and nothing shared with anyone else.

## What you see

Choose **7 days**, **30 days** or **90 days** at the top right. Everything on the tab covers that period.

![Acme's Insights for 7 days: 602 readers and 971 page views (both up 32% on the previous 7 days), 15 Ask AI answers with 11 unanswered, 80% found it helpful from 30 votes, and the Readers per day line from Oct 27 to Nov 2, its last day (today) dashed.](/docs-assets/guides/insights/insights-overview.webp)

- **Four numbers at the top**: readers, page views, Ask AI answers (and how many it couldn't answer), and the share of votes that said a page helped. Each shows its change from the period before, once Insights was collecting then. A number that can't be counted yet shows as **—**.
- **Readers per day**. Hover a day, or use the arrow keys, to see its readers and page views. A reader is counted once per day: someone who reads on Monday and Tuesday counts as two. Today is still counting, so its part of the line is dashed and marked **today so far**.
- **Top pages**, with how many views each had and how many readers found it helpful. A share under 70% shows in red: that page is worth a second look. Choose a page to open it in the editor.
- **What readers couldn't find**: searches with no results and questions [Ask AI](/guides/ask-ai) couldn't answer from your pages, in one list, the most frequent first. The same words searched and asked are one row. Choose **Write a page** to open **New page** in the editor with a title already filled in from what readers typed.
- **Reader feedback**: comments and "not helpful" votes to work through (see [Page feedback](#page-feedback)).

![Top pages with views and helpful share, Quickstart first at 60% in red, and What readers couldn't find: searches with no results ("sso", "csv export", "snowflake", "rate limit") and questions Ask AI had no answer for, like "Is there a Terraform provider?" and "Do you support SSO with Okta?", each with Write a page.](/docs-assets/guides/insights/insights-pages.webp)
- **Where readers come from**: the sites that link to your guide, like `google.com` or `github.com`, their countries, and their devices (computer, phone or tablet). Visits typed in, bookmarked or from apps that hide where they came from aren't listed under sites.
- **What readers look for**: what they type in the search box most, and the questions they ask Ask AI most.
- **Embedded files**, when pages [embed Markdrop files](/guides/embed-files#see-how-readers-use-them): each block's views and use, a video's plays and where viewers stop, a PDF's furthest page.

![Where readers come from, on Sites: google.com, github.com, news.ycombinator.com, bing.com, linkedin.com and duckduckgo.com with their counts, and What readers look for, on Searches: postgres, api key, alerts, invite, slack and more.](/docs-assets/guides/insights/insights-sources.webp)

New page views usually show within a minute.

The [Fix list](/guides/fix-list) turns all of this into one ranked list of what to fix next, with an AI-drafted fix for each item, and counts AI agents' reads apart from readers ([AI agents](/guides/fix-list#ai-agents)).

Before there's anything to show, the tab says why. A guide that isn't published yet links to **Publish**. A live guide with no readers yet shows its address to copy or open, and what will show up. A guide with Insights off explains what it does, and an admin can turn it on from there.

![A live guide with no readers yet: Collecting, "Your first readers will show up here", its address with Copy link and Open, and What you'll see: readers and top pages, searches with no results, Ask AI questions and page feedback.](/docs-assets/guides/insights/insights-empty.webp)

The [Markdrop Guides home](/guides/overview#your-guides) adds up the last 7 days across all your guides, and each live guide's card shows its views and how many readers found it helpful. A guide with Insights off shows no numbers there and isn't counted.

## Page feedback

Every page of a guide ends with **Did this page help?** Readers answer **Yes** or **Not quite**, and can add a comment of up to 1,000 characters. AI apps that read your guide through its [MCP server](/guides/ai-ready#the-mcp-server) can report a problem with a page too; those show as **via an AI app (MCP)**.

Comments and "not helpful" votes appear under **Reader feedback** as **Open**, with the page they're about and when they came in. **Open page** opens that page in the editor. When you've dealt with one, choose **Resolve**; it moves to **Resolved**, and **Reopen** puts it back.

![Reader feedback, 80% found pages helpful, Open 5 and Resolved 2: comments on Quickstart, Connect Postgres and API keys, one via an AI app (MCP) on the CLI reference, and a helpful comment on Alert rules, each with Open page and Resolve.](/docs-assets/guides/insights/insights-feedback.webp)

## Who can see it

| Role | Can |
| --- | --- |
| Viewer | See Insights |
| Editor, Reviewer | See Insights and resolve feedback |
| Admin | All of that, turn collection off, and delete what was collected |

See [Members and roles](/guides/members-and-roles).

## What's collected, and what isn't

Insights counts readers of the published guide only. Your own visits count too: Insights doesn't know who anyone is.

| Kept | Never kept |
| --- | --- |
| The page that was opened | Names, email addresses or accounts |
| The site a reader came from, without its address or search terms | IP addresses |
| The country | City, region or precise location |
| Computer, phone or tablet | The browser's full details |
| What was searched for, and how many results it had | Cookies or anything else stored in the browser |
| Ask AI questions | Page views, searches or feedback while Insights is off |
| "Did this page help?" votes and comments | |

**Visitors without tracking.** To count a visitor once a day, Insights makes a code from the reader's network address and browser with a random value that changes every day and is then deleted. The code can't be turned back into an address, and it changes the next day, so no one can be followed from one day to the next or from one guide to another.

**Do Not Track and Global Privacy Control.** When a reader's browser sends either signal, their page views and searches are counted, but no visitor code is made for them.

**Searches and questions are what readers typed.** Insights masks anything that looks like an email address or a long number in a search. Readers' questions and comments can still contain what they chose to type, so treat them like support messages.

**Your guide's readers aren't tracked by Markdrop.** Markdrop's own analytics never run on a published guide.

## How long it's kept

- Individual page views and searches: 90 days.
- Daily totals and page feedback: 13 months.
- Ask AI questions: 180 days. Ask AI keeps them that long to run the service whether or not Insights is on, but this tab only shows the ones asked while it was on.

Deleting a guide deletes its insights.

## Turn it off

Only a Guides admin can do this.

::::steps
### Open Insights
Open the guide and choose **Insights**.

### Switch collection off
In the **Collection** card at the bottom, turn the **Collecting** switch off. Nothing new is collected from then on.

### Publish
The next [publish](/guides/publishing) takes **Did this page help?** off the guide's pages, and your guide's MCP server stops offering to report problems.
::::

What was already collected stays until it expires. To delete it now, choose **Delete collected data**. Turning Insights back on starts counting again from that moment.

## Related

- [Fix list](/guides/fix-list): what to fix next, from the same signals.
- [Ask AI](/guides/ask-ai): the questions behind the numbers.
- [Embed files that render](/guides/embed-files#see-how-readers-use-them): how readers use embedded files.
