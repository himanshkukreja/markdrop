---
title: Collaboration for AI apps
description: Let Claude, ChatGPT, Cursor or any MCP app read and answer comment threads, suggest edits, file Jira issues from discussions and tell you what's waiting on you.
updated: 2026-11-09
nav: For AI apps
prerequisites: [/ai/hosted-mcp]
keywords: [mcp, ai apps, claude, chatgpt, cursor, comments mcp, list_comments, get_thread, add_comment, reply_comment, edit_comment, delete_comment, resolve_comment, reopen_comment, assign_thread, react_comment, set_comment_settings, list_waiting_on_me, suggest_edit, accept_suggestion, reject_suggestion, withdraw_suggestion, summarize_discussion, comment_insights, thread_to_jira, insert_jira, update_jira_issue, list_jira_transitions, create_jira_issue, get_comment_notifications, set_comment_notifications, example prompts]
---

Everything on these pages works from an AI app connected to Markdrop's [hosted MCP server](/ai/hosted-mcp). The app acts as you, with your access: it sees the comments you can see, and it can only resolve, accept or delete what you could on the website. Writing needs the write permission you gave the app when you connected it.

## Try asking

> What's waiting on me in Markdrop today?

The app calls `list_waiting_on_me` and lists the threads assigned to you, mentioning you or answered in threads you started, with links.

> Read the comments on our checkout launch plan and reply to Alex's question about sign-off: Sam owns it, and it's on Monday.

`list_comments` finds the thread, `reply_comment` answers it as you.

> On the pricing page, suggest replacing "with the annual price first" with "with the monthly price first, annual one click away", and tell Sam why.

`suggest_edit` starts a thread on that exact text with the suggested words; an editor accepts it in one click.

> Summarize the discussion on the launch plan. Accept Sam's two-waves suggestion, and reject the one about moving support's article.

`summarize_discussion`, then `accept_suggestion` and `reject_suggestion`.

> Turn the thread about help-article screenshots into a Jira issue in PAY, assigned to Alex. Show me the draft first.

`thread_to_jira` with `draft: true` returns the draft and creates nothing; the app shows it to you, then calls it again with `draft: false`.

> Put a live list of open PAY issues under "Open work" in the launch plan, and move PAY-3 to In Progress.

`insert_jira` adds the list; `list_jira_transitions` and `update_jira_issue` move the issue as you.

> Only email me about comment mentions once a day, and stop the reply emails.

`set_comment_notifications` with `email_mentions: daily` and `email_activity: off`.

## The tools

### Threads

| Tool | Permission | What it does |
| --- | --- | --- |
| `list_comments` | read | The threads on a page or Markdown document: status, what each is about, the assignee and every message |
| `get_thread` | read | One thread with every message |
| `list_waiting_on_me` | read | Open threads across everything you can open that wait on you: assigned to you, mentioning you, or answered in a thread you started (`view`: `waiting`, `assigned`, `mentions`) |
| `add_comment` | write | Starts a thread on quoted text, a block or the page, with mentions and an assignee |
| `reply_comment` | write | Replies to a thread (a resolved one opens again) |
| `edit_comment` | write | Changes the text of one of your own messages |
| `delete_comment` | write | Deletes one of your own messages; the page's owner and workspace admins can delete anyone's |
| `resolve_comment`, `reopen_comment` | write | Resolves or reopens a thread |
| `assign_thread` | write | Assigns a thread to someone as a task, or clears it |
| `react_comment` | write | Adds or removes your emoji reaction |
| `set_comment_settings` | write | The owner's switches: comments on or off, shown publicly or not |

### Suggestions and AI

| Tool | Permission | What it does |
| --- | --- | --- |
| `suggest_edit` | write | Suggests replacement words for a passage, on a thread or a new one on the exact text |
| `accept_suggestion` | write | Accepts it (people who can edit): the page changes, as its own version |
| `reject_suggestion` | write | Turns an open suggestion down (people who can edit) |
| `withdraw_suggestion` | write | Takes back your own open suggestion |
| `summarize_discussion` | read | What was decided, what's open and who it's waiting on, within fair-use limits |
| `comment_insights` | read | Open and resolved threads, first reply, time to resolve, most-discussed sections |

### Jira

| Tool | Permission | What it does |
| --- | --- | --- |
| `thread_to_jira` | write | Drafts (`draft: true`, the default) or creates an issue from a thread and links them; `put_chip` also puts the issue's chip after the text the thread is about |
| `insert_jira` | write | Puts an issue on a page as a chip or a card, or adds a live list |
| `update_jira_issue` | write | Changes an issue as you: a workflow step, the assignee, a comment, the title, priority or due date |
| `list_jira_transitions` | read | The steps you can take on an issue now, and the fields each needs |
| `create_jira_issue` | write | Drafts or creates an issue from an item or selected text |

### Notifications

| Tool | Permission | What it does |
| --- | --- | --- |
| `get_comment_notifications` | read | Your comment email (mentions, replies), daily digest, push and Slack settings |
| `set_comment_notifications` | write | Changes them: email `instant`, `hourly`, `daily` or `off`; digest, push and Slack switches on or off. Slack notifications themselves are turned on in the app. |

Every tool's inputs are in the [MCP tools reference](/ai/tools#comments).
