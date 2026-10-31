---
title: Insights for your guide
nav: Insights
description: How readers use your published guide. Views, top pages, searches with no results, Ask AI questions and page feedback, with no cookies or personal data.
updated: 2026-10-31
prerequisites: [/guides/publishing]
keywords: [insights, analytics, page views, visitors, top pages, referrers, searches, no results, feedback, was this helpful, ask ai questions, privacy, cookies, gdpr, do not track]
---

**Insights** shows how readers use your published guide: which pages they open, where they come from, what they search for, what they ask Ask AI and whether a page helped them. Open a guide and choose **Insights** in the bar at the top. It's on for every guide, with no setup and no code to add.

Insights is privacy-first: no cookies, nothing stored in readers' browsers, no personal data, and nothing shared with anyone else.

## What you see

Choose **7 days**, **30 days** or **90 days** at the top right. Everything on the tab covers that period, and the numbers at the top compare it with the period before.

- **Page views and visitors** per day. Hover a day to see both. A visitor is counted once per day: someone who reads on Monday and Tuesday counts as two.
- **Top pages**, with how many views each had.
- **Where readers come from**: the sites that link to your guide, like `google.com` or `github.com`. Visits typed in, bookmarked or from apps that hide where they came from aren't listed.
- **Searches**: what readers type in the search box most, and **searches with no results**. A search with no results usually means a missing page, or a word your pages don't use yet.
- **Ask AI questions**, when [Ask AI](/guides/ask-ai) is on: the questions asked most, and the ones it couldn't answer from your pages.
- **Feedback**: the share of readers who said a page helped, the pages with the most "not helpful" votes, and every comment with the page it's about.
- **Countries and devices**: computer, phone or tablet.

New page views usually show within a minute.

## Page feedback

Every page of a guide ends with **Did this page help?** Readers answer **Yes** or **Not quite**, and can add a comment of up to 1,000 characters. AI apps that read your guide through its [MCP server](/guides/what-readers-get#for-ai-tools) can report a problem with a page too; those show as **From an AI app**.

Comments and "not helpful" votes appear under **Feedback** as **Open**. When you've dealt with one, choose **Mark as resolved**. **Reopen** puts it back.

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
Under **Collection** at the bottom, turn the switch **Off**. Nothing new is collected from then on.

### Publish
The next [publish](/guides/publishing) takes **Did this page help?** off the guide's pages, and your guide's MCP server stops offering to report problems.
::::

What was already collected stays until it expires. To delete it now, choose **Delete collected data**. Turning Insights back on starts counting again from that moment.
