---
title: Jira in pages
description: Put Jira issues anywhere in a page as live chips, cards or lists, change their status and assignee from the page, and turn a comment thread into an issue.
updated: 2026-11-09
prerequisites: [/pages/overview, /integrations/jira]
keywords: [jira, jira in pages, jira chip, jira card, jira list, jql, saved filter, project, live list, issue card, paste jira link, /jira, at jira, status, transition, workflow, assignee, jira comment, edit issue, priority, due date, sprint, create jira issue, selected text, comment thread, resolve, connect jira, privacy, snapshot, insert_jira, update_jira_issue, list_jira_transitions, create_jira_issue, mcp]
---

Jira issues can live anywhere in a page: in a sentence, as a card with their details, or as a live list from a project, a saved filter or a JQL query. People who are signed in and have connected their own Atlassian account see each issue's live status and can change it from the page. Everyone else sees the issue's key and title.

Jira in pages works with any Jira Cloud site your Atlassian account reaches. A workspace that's [connected to Jira](/integrations/jira) also gets its site filled in for you, so `PAY-12` is enough.

## Three ways to show an issue

| Form | What readers see | Add it with |
| --- | --- | --- |
| **Chip**, inside text | The key and title, and the status for people whose Jira can open it. Select it to open the issue's card. | Paste a Jira link, type **/jira**, or type **@** and the key (for example **@PAY-12**) |
| **Card**, a block | Title, status, assignee, priority, type, due date, sprint and when it was last updated, with buttons to change them | **/Jira card**, or select a chip and choose **Show as a card** |
| **List**, a block | A table of issues, always current, with the status of each row ready to change | **/Jira list** |

### Paste a Jira link

Paste a link such as `https://acme.atlassian.net/browse/PAY-12` on its own and it becomes a chip straight away. Press **⌘ Z** (**Ctrl Z**) to keep the plain link instead.

### Add a chip or a card

1. Type **/jira** (the chip) or **/Jira card** in a page.
2. Search your Jira by key or by words from the title. With nothing typed, the picker lists issues assigned to you or reported by you.
3. Choose the issue, or paste its key or link.

To start a new issue right there, type **/New Jira issue**, write what it's about and choose **Create**. Markdrop AI drafts the issue; you check every field, then it's created as you and its chip goes where you typed.

### Add a live list

1. Type **/Jira list**.
2. Choose where the issues come from:
   - **Project**: every issue in a project, newest first. Enter its key, such as `PAY`.
   - **Saved filter**: a filter you saved in Jira. Enter its number, the one in the filter's address.
   - **JQL**: any Jira query, such as `project = PAY AND status != Done ORDER BY priority DESC`.
3. Optionally give it a title, choose its columns (status, assignee, priority, type, due date, sprint, updated) and how many issues to show per page.
4. Choose **Show issues**.

A list shows 25 issues at a time; **Load more** shows the next ones. Select **Edit list** on the block to change it.

:::note[Each reader sees their own list]
A list's query runs as the person reading the page, through their own Jira. Nobody sees an issue their Jira wouldn't show them, even if the person who wrote the query can see more. Readers can only run the lists saved on the page.
:::

## Create an issue from text on the page

Select some text, then choose **Create Jira issue** in the toolbar. Markdrop AI drafts the issue from the text: summary, description, project, type, priority, assignee and due date. Change anything, then select **Create issue**. The issue is created as you, and the text you selected becomes the new issue's chip.

This needs the page to be in a workspace that's connected to Jira.

## Change an issue from the page

Open a chip (select it) or use a card or a list row. These changes are made in Jira **as you**, so Jira's own permissions decide what you can do:

- **Status.** Select the status to see every step your Jira workflow offers you, not just Done. When a step asks for more, such as a resolution, Markdrop asks you for it before moving the issue.
- **Assignee.** Search the people Jira lets you assign the issue to, or choose **Unassign**.
- **Comment.** Add a comment to the issue in Jira.
- **Edit.** Change the title, priority or due date.

If Jira refuses a change, Markdrop shows Jira's reason as it is, for example "Jira says you don't have permission to move PAY-12".

Changes show for everyone reading the page within a few seconds. Each person's page reads the issue again through their own Jira, so nobody is sent details they couldn't see.

## Turn a comment thread into an issue

In a [comment thread](/pages/comments), open the thread's menu and choose **Create Jira issue**. Markdrop AI drafts the issue from the discussion, you review it, and it's created as you. The issue's description links back to the thread, and the thread shows the issue under its first comment.

You can also choose **Link a Jira issue** to connect a thread to an issue that already exists, or **Unlink the Jira issue**.

The two stay in step without surprises:

- Resolve the thread while the issue is still open, and the thread offers **Move to Done** in Jira.
- When the issue is Done in Jira and the thread is still open, the thread offers **Resolve discussion**.

## Who sees what

| Who | What they see |
| --- | --- |
| Signed in, Atlassian account connected, and their Jira can open the issue | Live status, assignee, priority, due date and sprint, and the buttons to change them |
| Signed in, Atlassian account connected, but their Jira can't open the issue | The key and title |
| Signed in, no Atlassian account connected | The key and title, and **Connect Jira** |
| Not signed in | The key and title, as a link to the issue in Jira |

The title readers see is the one saved when someone who can edit the page added the issue. It follows renames made in Jira. Lists show nothing to people without Jira, only **Connect Jira** or a note to sign in. Markdrop never asks Jira anything on behalf of someone who isn't signed in.

To connect your account, select **Connect Jira** on any chip, card or list, or go to **Settings › Account › Jira**.

## In exports and AI apps

Jira chips, cards and lists leave [exports](/pages/export) as plain links: the key and title, linking to the issue in Jira, and a list as a link to its query in Jira. Your exported page reads well in any app.

In the page's Markdown they're written as:

```markdown
Blocked on :jira[PAY-12]{site=acme.atlassian.net} until Friday.

::jira{key=PAY-3 site=acme.atlassian.net}

::jira-list{jql="project = PAY AND status != Done" cols="status,assignee,due" limit=25 title="Open payments work"}
```

`site` is optional when the page's workspace is connected to Jira.

## For AI apps (MCP)

| Tool | What it does |
| --- | --- |
| `insert_jira` | Puts an issue on a page as a chip or a card, or adds a live list (JQL, a project or a saved filter), at the end or after a heading |
| `update_jira_issue` | Changes an issue as you: a workflow step by name (with the fields it needs), the assignee, a comment, the title, priority or due date |
| `list_jira_transitions` | The steps you can take on an issue now, and the fields each one needs |
| `create_jira_issue` | Drafts or creates an issue from an item or selected text; from selected text, that text becomes the issue's chip |

`get_page` lists the page's Jira chips, cards and lists as plain links. See [Connect an AI app](/ai/hosted-mcp) and [MCP tools](/ai/tools).
