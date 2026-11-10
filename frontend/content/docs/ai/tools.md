---
title: MCP tools
nav: Tools
description: Every tool of Markdrop's hosted MCP server and the local markdrop mcp server, grouped by area, with the permission and inputs each one takes.
updated: 2026-11-07
keywords: [mcp tools, comments, list_comments, get_thread, add_comment, reply_comment, resolve_comment, reopen_comment, assign_thread, react_comment, set_comment_settings, ask_suggestions, suggested questions, ask my files, take_over, locked, edit lock, is editing, ask markdrop, thread_id, catch_up, my_actions, analytics_story, ask_analytics, content_gaps, content gaps, search, ask_documents, ai search, fuzzy search, publish_document, publish_page, set_access, create_upload, upload_file, share_files, get_document_analytics, get_viewers, set_presence, who's viewing, create_page, get_page, update_page, append_blocks, replace_section, insert_embed, set_page_properties, upload_page_image, move_page, translate_page, summarize_page, suggest_page_meta, pages, sub-pages, scopes, reference, list_page_versions, get_page_version, restore_page_version, version history, export_page, list_page_templates, save_page_as_template, set_folder_default_template, default template, templates, create_page_image_upload, complete_page_image_upload, copy_page_asset, page cover, set_slug, change link, custom link, slug, duplicate_page, list_workspace_members, people, mentions, delete_document, restore_document, list_trash, trash, restore, undo delete, notifications, list_notifications, mark_notifications_read, share_with_people, notify, request_edit_access, list_access_requests, decide_access_request, access requests, approve, list_signoffs, sign_off, sign-off, approval, set_folder_properties, list_folder_pages, typed properties, database views, auto_cover, automatic covers, analyze_document_engagement, analytics ai, import_meeting, list_meetings, get_meeting, ask_meetings, meeting_context, meeting memory, decisions, meetings, transcripts, google meet, meetings_connection, check_meetings_now, check for new meetings, check now, auto import, rename_folder, move_folder, delete_folder, create_folder, folders, on_conflict, idempotency_key, idempotency, retry, duplicate, base_rev, stale write, overwrite, import_meetings_bulk, organize_meetings, import past meetings, meeting series, drive_url, slack, slack_status, post_meeting_to_slack, post to slack, meetings channel, team, team memory, list_team, get_person_profile, get_project_status, who is working on, status, set_my_status, set_focus_note, hide_team_line, correct_team_line, mark_team_item_done, list_team_groups, save_team_group, delete_team_group, send_weekly_summary_now, weekly summary, groups, waiting for gemini, jira, jira_status, create_jira_issue, link_jira_issue, list_jira_issues, transition_jira_issue, tickets, get_document_viewers, get_view_timeline, who viewed, view timeline, get_analytics_settings, set_analytics_settings, analytics settings, what's tracked, suggest_edit, accept_suggestion, summarize_discussion, suggested edits, insert_jira, update_jira_issue, list_jira_transitions, jira in pages, comment_insights, comment analytics, export with comments, edit_comment, delete_comment, list_waiting_on_me, waiting on me, reject_suggestion, withdraw_suggestion, thread_to_jira, get_comment_notifications, set_comment_notifications, teams, list_teams, get_team, create_team, update_team, add_team_members, remove_team_members, move_to_team, share_to_team, get_team_brief, edit_team_brief, list_projects, create_project, route_meeting, space]
---

Markdrop has two MCP servers. The hosted server at `https://api.markdrop.in/mcp` has 132 tools; the local server, `markdrop mcp` in the CLI, has 13. Your assistant picks the tool from what you ask; you rarely need the names. This page is the reference for when you do.

In the tables, **Permission** is the one the app must have been given when you approved it: `read` is `documents:read` and `write` is `documents:write`. See [Connect an AI app](/ai/hosted-mcp#the-two-permissions).

Wherever a tool takes `document`, it accepts a slug (`q3-report`), a markdrop.in link, or the document's link on a workspace's own domain. Wherever it takes `workspace`, it accepts the workspace's id, its name or one of its custom domains.

Every `write` tool also takes an optional `idempotency_key`, a unique id for the change (a UUID). If the app retries with the same key within 24 hours, after a timeout for example, it gets the first call's result and nothing is done twice: no second page, appended block or upload. A call that failed isn't remembered, so retrying it runs it again. Keys are per account and per tool.

## Hosted server tools

### Publish and edit

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `publish_document` | write | Publishes Markdown as a document that renders headings, tables, code, Mermaid diagrams and math. Returns the link. | `markdown`, and the publish options below |
| `publish_page` | write | Publishes a complete HTML page, or a `.txt`, `.csv`, `.json` or `.svg` file, as a link that opens rendered. Up to 25 MB. | `filename` (with its extension), `content`, and the publish options |
| `update_document` | write | Replaces the full content of a document or text file, keeping its link. Works on documents you own or can edit. With `base_rev` (the `rev` from `get_document`), nothing is written if it changed since you read it; always pass it. See [Working together on a page](/pages/working-together). | `document`, `content`, `title`, `base_rev` |
| `set_slug` | write | Changes the link of a page, document or file you own. The old link keeps working: it redirects to the new one on markdrop.in and on the workspace's own domain, sub-page addresses included, and embeds and mentions of the old slug keep working. A slug another document has or had, or one deleted less than 30 days ago, is an error that names it. Refused while someone has the page open in the editor. | `document`, `slug` |
| `delete_document` | write | Deletes a document, page or file you own: exactly the one at the slug or link you give, never another item with the same title. It goes to [Trash](/documents/trash) for 30 days: the link stops working at once, and `restore_document` (or Trash in Markdrop) brings it back as it was. `permanent: true` deletes it forever instead, also for an item already in Trash; only its owner can (for an item in Trash, a workspace admin too), and assistants should do it only when you ask for exactly that. Marked as destructive, so apps that honour that ask you first. A page with pages inside it needs `children`: `delete` sends them to Trash with it (they come back with it), `lift` moves them up a level. The result lists every item in `deleted_items` (`slug`, `title`, `kind`: `file`, `page` or `document`) and any sub-pages moved up in `lifted_items`, with `trashed` and `restore_until`. | `document`, `children`, `permanent` |
| `restore_document` | write | Brings a document, page, file or folder back from [Trash](/documents/trash) within 30 days of the delete: a page with the sub-pages deleted with it, a folder with everything in it. It returns where it was: the same link, page, workspace, folder, access and people; `notes` says when it went to the top level instead because its page, folder or workspace is gone. | `document` (a slug or link, or a folder's id from `list_trash`) |
| `list_trash` | read | What you can restore: your deleted items, and everything deleted from workspaces you administer, newest first, with where each was, who deleted it, when, and how many days are left. | `workspace` |

The **publish options** are all optional:

| Option | Values |
|---|---|
| `title` | Up to 200 characters |
| `slug` | A custom address, 3 to 50 letters, digits, `-` or `_`. A taken slug is an error that names it, never a silent rename. Random when omitted. Change it later with `set_slug`. |
| `access` | `link` (anyone with the link, the default outside a workspace), `private`, `password` or `workspace` |
| `password` | Required with `access: "password"` |
| `expires` | `never` (default), `1h`, `1d`, `7d` or `30d`, counted from now |
| `workspace`, `folder` | File it in a workspace and an existing folder there. Without `access`, the folder's setting for new items applies, otherwise the workspace's default. |

`publish_document` also takes `editor`: `classic` (the default) opens the document in the Markdown editor, `blocks` makes it a [page](/pages/overview) that opens in the block editor, like `create_page`.

Results carry `url` (on the workspace's custom domain when it has a live one), `markdrop_url`, `slug`, `title`, `access` and `expires_at`; `publish_document`'s also carry `editor`.

### Read and find

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `get_document` | read | Reads a document or text file you can open: content (up to 200,000 characters), title, access, views, workspace, folder and `rev` (what `update_document` takes as `base_rev`). For other files it returns the file's details instead. | `document` |
| `list_documents` | read | Lists documents and files, newest first, each with its `type`. | `query`, `kind` (`all`, `document`, `file`), `type` (`all`, `document`, `pdf`, `video`, `image`, `sheet`, `slides`, `word`, `html`, `other`), `scope`, `limit` (1–50, default 20), `cursor` |
| `search` | read | Searches everything you can open, the way [Search](/workspaces/search) does: titles, headings, text and file contents, with typos, partial words and any word order. Each result has its kind, where it lives and the matching snippet. Returns ids to pass to `fetch`. | `query`, `scope` (`all`, `mine`, `workspaces`, `workspace:<id>`), `kind` (`page`, `doc`, `file`, `folder`, `workspace`, `guide`), `owner` (`anyone`, `me`), `updated` (`any`, `week`, `month`), `limit` |
| `fetch` | read | Returns the full text of a search result. | `id` |
| `ask_documents` | read | Asks a question about everything you can open, the way [Ask](/workspaces/ask-markdrop) does: meetings and their transcripts, documents, pages, files and Guides. Markdrop's AI answers briefly and cites its sources as [n] (a meeting's transcript moment as [n-sK]) with their links. Returns a `thread_id`: pass it back to ask a follow-up. `intent` `catch_up` summarises the last 7 days; `my_actions` lists open tasks that @mention you. `page` asks about that document or page first (then its workspace's meetings and documents), like **Ask this page**; `folder` asks only that folder and its sub-folders, like **This folder**; `scope` `mine` asks only your own items outside any workspace, like **Ask my files**. Counts towards your AI limits; workspaces with AI turned off are left out. | `question`, `scope` (`all`, `workspace:<id>` or `mine`), `thread_id`, `intent` (`ask`, `catch_up`, `my_actions`), `page` (slug or link), `folder` (id, with `scope`) |
| `ask_suggestions` | read | What to ask right now, as on the [Ask page](/workspaces/ask-markdrop#suggested-questions): a workspace's live team questions, each with its topic ("Sourcing: What did we decide this week?"), written from the last 7 days of meetings and pages every member can open (never a restricted meeting or a private page) and the same for every member, plus your own (your action items, your latest meeting). Without `workspace`, only your own. Reading the list never calls the model. | `workspace` (id, optional) |

For `list_documents`, `scope` is `mine` (default: your own), `workspaces` (what you can open in your workspaces) or `all` (both, plus documents shared with you). For `search` it defaults to `all`. Its `type` keeps one kind of item, the same as the [type chips](/get-started/tour#filter-by-type) in the app: `document` (Markdown documents and pages), `pdf`, `video`, `image`, `sheet` (Excel and CSV), `slides` (PowerPoint), `word`, `html` (HTML pages and zipped sites) or `other`.

Password-protected and end-to-end encrypted documents can't be read by any tool.

### Pages

Pages are documents that open in the block editor, with sub-pages, embedded Markdrop items, images and page properties.

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `create_page` | write | Creates a page, from a template or your own Markdown, in a workspace folder or inside another page. `template` is a built-in id or a workspace or personal template's id or slug; `{{title}}`, `{{date}}`, `{{author}}` and `{{folder}}` are filled in. In a folder with a default template, a page with neither `template` nor `content` starts from it (`template: "blank"` for an empty page); a page made inside another page starts blank unless you name a template. A page made inside another page lives in that page's workspace and folder and has the same access. `slug` gives it its link (the rules of the publish option; a taken slug is an error naming it, and nothing is created). A page without a cover gets one picked for what it's about ([automatic covers](/pages/overview#automatic-covers)); the result's `cover` says which and `cover_auto` that it was picked. `auto_cover: false` makes a page with no cover. In a folder with typed properties (`set_folder_properties`), `properties` also takes them, by key or name, checked before the page is created; they override a template's defaults. | `title`, `slug`, `template`, `content`, `properties`, `workspace`, `folder`, `parent`, `auto_cover` |
| `get_page` | read | Reads a page for editing: its Markdown, revision, properties (its folder's typed properties too, by key, with `property_values` giving each with a readable value), parent and sub-pages, the Markdrop items it embeds or mentions (each with whether you can open it) and its images. Also says who is editing it right now. | `document` |
| `update_page` | write | Replaces a page's whole Markdown. Nothing is saved if the page changed since the revision you read. | `document`, `markdown`, `base_rev` |
| `append_blocks` | write | Adds Markdown at the end of a page. Works even while someone is editing it: their editor shows the new blocks at once. | `document`, `markdown` |
| `replace_section` | write | Replaces one section: from the heading you name to the next heading of the same or a higher level. | `document`, `heading`, `markdown` |
| `insert_embed` | write | Puts a Markdrop item you can open into a page, embedded or as an inline link, at the end or at the end of a section. | `document`, `item`, `as` (`embed`, `link`), `mode` (`live`, `preview`, `card`), `after_heading` |
| `set_page_properties` | write | Sets a page's icon, cover and its focal point, full width, small text, font, lock and whether readers can export it. An image icon or cover is `asset:<id>` of an image of that page. `cover: "auto"` picks a cover for the page again, as new pages get one; `cover: null` removes it, and an automatic cover is then never added back. `properties` sets the typed properties of the page's folder (`{key or name: value}`, `null` clears one): a select option's name, a member's user id, `YYYY-MM-DD`, text, a number, `true`/`false`, or an `https://` address or page slug. A value that doesn't fit is refused with the reason. `template: true` turns the page itself into a template of its workspace (or yours, for a personal page) and `false` turns it back; pages already made from it never change. | `document`, `icon`, `cover`, `cover_y`, `full_width`, `small_text`, `font`, `locked`, `allow_export`, `properties`, `template`, `base_rev` |
| `upload_page_image` | write | Uploads a small image sent as base64 (up to 10 MB) to a page and returns the Markdown that shows it. Anyone who can read the page sees it, nobody else. For an image file, `create_page_image_upload` is better: no base64, and up to 20 MB. | `document`, `filename`, `content_base64` |
| `list_page_templates` | read | Every template you can start a page from, each with its `id`: the built-in ones (feature guide, customer how-to, QA test plan, product spec, meeting notes, runbook and blank), your own, and those of each workspace you're a member of. With `workspace`, only that workspace's and the built-in ones. With `parent` (a page), what a sub-page of it can start from: the built-in ones, its workspace's and yours, and `folder_default`, the default template of the page's folder. | `workspace`, `parent` |
| `save_page_as_template` | write | Saves a copy of a page, with its images and optionally the sub-pages you can open, as a template for your workspace (members and up) or for you alone. `{{title}}`, `{{date}}`, `{{author}}` and `{{folder}}` in it are filled in on each new page. Templates never appear in lists or search. | `document`, `name`, `description`, `icon`, `include_subpages`, `scope` (`workspace`, `personal`), `workspace` |
| `set_folder_default_template` | write | Chooses the template New page starts from in a workspace folder (workspace admins): a built-in id or one of the workspace's templates, or `null` for blank. | `workspace`, `folder`, `template` |
| `set_folder_properties` | write | Makes a workspace folder a database: defines the typed properties its pages have (workspace members and admins). Send the full list, in order: each `{name, type, options?}`, with types `select`, `multi_select`, `person`, `date`, `text`, `link`, `number` and `checkbox`. Keys are kept when you resend a property. A property you leave out is hidden, never deleted: pages keep their values. Optional `views` replace the folder's saved table and board views (up to 20). With `base_rev` (the `rev` that `list_folder_pages` or this tool returned) the change is refused if someone changed the properties since. See [Properties and views](/pages/properties-and-views). | `workspace`, `folder`, `properties`, `views`, `base_rev` |
| `list_folder_pages` | read | The pages filed directly in a folder that you can open, with their property values and links: the folder's rows. `display` gives each value as text (people's names; a linked page's title only when you can open it). Filter with `{property: value}` or `[{property, op, value}]`, sort with `"key"` or `"-key"`. | `workspace`, `folder`, `filter`, `sort`, `limit` (1–500, default 100) |
| `create_page_image_upload` | write | Starts adding an image file to a page without base64: a PNG, JPEG, GIF or WebP up to 20 MB, from a computer your assistant runs shell commands on. Returns a storage URL and the exact `curl` command that sends the file there. | `document`, `file_name`, `size_bytes`, `sha256`, `content_type`, `alt` |
| `complete_page_image_upload` | write | Finishes it: checks the size, the sha256 and that the file really is an image, then adds it to the page. Returns `asset:<id>` and the Markdown `![alt](asset:<id>)` to put in the page, or to use as its cover or icon. | `upload_id`, `parts` |
| `copy_page_asset` | write | Copies an image of one page to another page, as a new image of that page. You must be able to read the first page and edit the second. | `from_document`, `asset`, `to_document`, `alt` |
| `list_subpages` | read | The pages inside a page that you can open. | `document` |
| `move_page` | write | Puts a page inside another page of the same workspace, or at the top level. When that changes who can read it, the tool says how and needs `confirm_access_change`. | `document`, `parent`, `confirm_access_change` |
| `translate_page` | write | Translates a page into another language as a new page next to it, titled "Title (Español)", with the same blocks, embeds, images and properties. Only the text is translated, and the original isn't changed. Uses Markdrop's AI. | `document`, `language` |
| `summarize_page` | write | Writes a short summary of a page as a Summary callout, with Markdrop's AI. With `insert`, it's added at the top of the page; otherwise it's only returned. | `document`, `insert` |
| `suggest_page_meta` | write | Suggests a title, a one-sentence description and an emoji icon for a page, with Markdrop's AI. Changes nothing. | `document` |
| `list_page_versions` | read | A page's saved versions, newest first: when, who (a person, an AI app, or a restore) and which one matches the page now. Only people who can edit the page see them. | `document`, `cursor` |
| `get_page_version` | read | One saved version of a page: its Markdown, when and who. | `document`, `version` |
| `restore_page_version` | write | Makes an earlier version the page again, as a new version; the page as it was is kept, so a restore can be undone. Refused while someone has the page open in the editor. | `document`, `version` |
| `export_page` | read | Exports a page as portable Markdown or one HTML file, returned as text; with sub-pages (or `zip` for Markdown with images), a link to a `.zip` that works for 10 minutes; `word`, a link to a `.docx`. `comments` includes the page's comment threads (Markdown: a Comments section; Word: margin comments or footnotes), only when you can see them. Items you can't open are written as "Locked item", and readers can export only when the page allows it. See [Export a page](/pages/export). | `document`, `format` (`markdown`, `word`, `html`), `include_subpages`, `zip`, `comments` (`none`, `footnotes`, `margin`), `comment_status` (`open`, `all`) |
| `duplicate_page` | write | Copies a page you can read: its Markdown, properties and images (as the copy's own). The copy is yours and never locked, called "Copy of Title" unless you give a `title`. It goes inside `parent`, in `workspace` / `folder` (`folder` alone means the original's workspace), or else next to the original; you must be able to add pages there. Sub-pages only with `include_subpages` (up to 50 pages). Returns the link. | `document`, `title`, `workspace`, `folder`, `parent`, `include_subpages` |
| `list_signoffs` | read | A page's sign-off blocks: each one's `block` id, `label`, the `person` who signs it (and `person_name` when you may see names), its `options`, the decision (`option`, `signed_by`, `signed_at`; empty while waiting), `lock` (`above` when it locks the section above) and whether you're the one who signs (`you_sign`). The decision comes from Markdrop, never from the Markdown. | `document` |
| `sign_off` | write | Chooses an option in a sign-off block, only when you are the person it names; anyone else is refused, the page's owner and workspace admins included. `block` is its id or its label. `option: null` clears your decision, which unlocks the block. Your name and the time are recorded, and version history shows it. | `document`, `block`, `option` |

While someone is editing a page (from their first change until 2 minutes without one, or 60 seconds with their tab in the background), `update_page`, `replace_section`, `set_page_properties`, `insert_embed` with `after_heading`, `set_slug`, `restore_page_version`, `summarize_page` with `insert` and `update_document` are refused with error `locked`. The message and the result's fields say who (`holder`), how long they've been idle (`idle_s`), whether they have unsaved changes (`dirty`), when the page will be free (`releases_in_s`) and whether you may take over (`can_take_over`). Wait, use `append_blocks`, or, as the page's owner or a workspace admin and after asking the user, call again with `take_over: true`: the person editing is told and their unsaved changes are kept in [version history](/pages/history). A page someone only has open, without editing, never blocks a write. See [Editing together](/pages/editing-together). Adding an image to a page works while someone is editing it; putting its Markdown in the page follows the same rules. A locked page can be changed only by its owner or a workspace admin. Web embeds (`::embed`) are accepted from YouTube, Vimeo, Loom, Figma, Google Maps and CodePen only.

A page's link is its slug: `markdrop.in/<slug>`, and on the workspace's own domain `/<folders>/<parent pages>/<slug>`. For example, `create_page` with `title`, `slug: "sl-template-prd"`, `workspace` and `folder: "product-hub/templates"` returns `https://docs.acme.com/product-hub/templates/sl-template-prd`. Change it later with `set_slug`; the old link redirects.

Readers who can't open an embedded or mentioned item see a locked placeholder with no title. In a page, people mentioned with `@` are named only to the page's owner and its workspace's members.

To mention someone, write `:person[Name]{id="<id>"}` with an id from `list_workspace_members`, or just `:person[Name]`: when exactly one member of the page's workspace has that name (upper and lower case ignored), Markdrop adds the id as it saves. Names it can't match, or that more than one member has, stay plain text, and `create_page`, `update_page`, `replace_section` and `append_blocks` list them in `unresolved_people`. Names are looked up only when you're a member of the page's workspace.

Everyone a tool newly mentions on a page (or names on a sign-off block) is notified in your name, as when you edit the page yourself, if they can open it. Put the mention in a block with an anchor (`{#b-…}`) and the notification links straight to it. See [Mentions and notifications](/pages/mentions-and-notifications).

Sign-off blocks (`:::signoff{#b-… person="<user id>" label="…" options="A|B" lock=above}`): once one is signed, `update_page`, `replace_section`, `append_blocks`, `update_document` and `restore_page_version` are refused when they would change or delete it, or change the section it locks; the error names who signed it. A workspace admin may remove a signed block, and the removal is recorded. See [Sign-off](/pages/sign-off).

`duplicate_page` details: without a target, the copy goes in the original's parent page if you can add pages there, else in its workspace folder if you're a member, else among your own pages (private unless the original is public to anyone with the link). The copy has what you can read of the original, its own copies of the images, and the access of a new page where it lands. A sub-page with its own access isn't copied and is named in `skipped_subpages`; images that couldn't be copied are in `images_missing`. End-to-end encrypted pages and files can't be duplicated. See [Duplicate a page](/pages/overview#duplicate-a-page).

### Access

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `set_access` | write | Changes who can open a document you own: `link`, `private`, `password` or `workspace`. A document has one access level at every address, so `link` on a workspace document makes it public on markdrop.in and on the workspace's domain alike. | `document`, `access`, `password`, `remove_password`, `expires` |
| `share_with_people` | write | Shares a page, document or file with people by email, like **Share › Add people** in the app: `viewer` (can view, the default) or `editor` (can edit). With `notify` (default `true`) each person gets an email with the link and your `message`, and people with a Markdrop account get a notification. Someone who already had that access gets nothing. The website's rules apply: you must be allowed to share it, can't give more access than you have, and only the owner changes someone's role. Each address's result is listed, with the reason when it wasn't shared. | `document`, `emails` (1–20), `role`, `notify`, `message` (up to 500 characters) |

| `request_edit_access` | write | Asks for edit access to a page, document or file you can open but not edit, like **Request edit access** in the page's **⋯** menu. It goes to the owner (or, when the page has no owner who can be reached, the workspace's admins) as an email with **Approve** and **Decline** and your `message`, and you get an email when they decide. Approving lets you edit that page only, not its sub-pages. Refused when you can already edit it, can't open it, already have a request pending for it, or were declined in the last 24 hours; at most 10 requests an hour. Returns the request's id and whether it went to the owner or the admins. | `document`, `message` (up to 500 characters) |
| `list_access_requests` | read | Access requests, newest first, as **Access requests** in the app lists them. `incoming` (the default): people asking to open or to edit your documents, and edit requests sent to a workspace you administer because the page has no reachable owner; these are the ones you can decide. `outgoing`: the requests you made; a document you still can't open shows its slug only (`available: false`). Each has the id, the document, who asked (name and email), what they asked for (`role_requested`: `viewer` or `editor`), their message, the status and when. | `direction` (`incoming` or `outgoing`), `status` (`pending`, the default, `approved`, `declined` or `all`), `limit` (1–50, default 50) |
| `decide_access_request` | write | Approves or declines an access request you may decide: as the document's owner, or as a workspace admin for an edit request sent to the admins. Like **Approve** and **Decline** in the app: approving shares the document with the requester's email address (an edit request: they can edit that page only; a request to open it: **Can view**, or **Can edit** with `role: "editor"`), and they get an email either way. Assistants should confirm with you before approving. Deciding again the same way changes nothing; deciding the other way is refused. | `request`, `decision` (`approve` or `decline`), `role` |

With `access: "link"`, a password the document already has is kept and applies again unless `remove_password` is `true`.

### Notifications

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `list_notifications` | read | Your notifications, newest first, as the bell shows them: someone mentioned you (`mention`), asked for your sign-off (`signoff_requested`) or shared a page with you (`shared`). Each has a sentence, who did it, the page, a `url` to the block, an excerpt and whether it's read. A page you can no longer open comes back with `available: false` and no title, link or excerpt. | `unread_only`, `limit` (1–100, default 20), `cursor` |
| `mark_notifications_read` | write | Marks your notifications read: the `ids` from `list_notifications`, or `all: true`. Returns how many changed and how many are still unread. | `ids` or `all` |
| `get_comment_notifications` | read | Your comment notification settings: email for comment mentions and assignments and for replies and new comments (`instant`, `hourly`, `daily`, `off`), the daily comments digest, and push and Slack for comment mentions and assignments. | none |
| `set_comment_notifications` | write | Changes them: `email_mentions` and `email_activity` (`instant`, `hourly`, `daily`, `off`), `digest`, `push_mentions`, `push_assigned`, `slack_mentions`, `slack_assigned` (on or off). Slack notifications themselves are turned on in the app. | any of those |

Notifications are kept for 90 days. See [Mentions and notifications](/pages/mentions-and-notifications). Comment notifications: see [Comment notifications](/collaboration/notifications).

### Comments

Threads on pages and markdown documents, as in Markdrop's [comments panel](/collaboration/comments). Each tool acts as you, with your access; encrypted documents, files and documents without an owner have no comments.

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `list_comments` | read | The threads on a page or document, oldest first: each one's `id`, `status` (`open` or `resolved`), what it's about (`quote`, the commented text; `anchor.block_id`; or the page), `anchor_status` (`changed` when the text was edited away, with `original_quote`), who started it, the assignee and every message with its reactions. | `document`, `status` (`open`, `resolved`, `all`) |
| `get_thread` | read | One thread with every message. | `document`, `thread_id` |
| `add_comment` | write | Starts a thread: on text with `quote` (exactly as the page shows it; `occurrence` picks the n-th match), on a whole block with `block` (its `b-…` id), or on the page when you give neither. The page's text never changes. People in `mentions` (user ids or emails of people who can open it) are notified; `assignee` makes it a task on their home. Returns the thread and its link. | `document`, `body`, `quote`, `block`, `mentions`, `assignee` |
| `reply_comment` | write | Replies to a thread (a resolved one opens again). Everyone in the thread is notified, and so is anyone in `mentions`. | `document`, `thread_id`, `body`, `mentions` |
| `resolve_comment` | write | Resolves a thread: the person who started it, its assignee and anyone who can edit the item may. History is kept. | `document`, `thread_id` |
| `reopen_comment` | write | Opens a resolved thread again. | `document`, `thread_id` |
| `assign_thread` | write | Assigns a thread to someone who can open the item (user id or email), as a task on their home and the Team page; `null` clears it. Editors and the thread's author may. | `document`, `thread_id`, `assignee` |
| `react_comment` | write | Adds (`on: true`) or removes (`on: false`) your emoji reaction on one message; toggles without `on`. | `document`, `thread_id`, `message_id`, `emoji`, `on` |
| `set_comment_settings` | write | The owner's switches: `enabled` (comments on or off) and `public` (show comments to readers who aren't signed in). | `document`, `enabled`, `public` |
| `edit_comment` | write | Changes the text (and mentions) of one of your own messages. Newly mentioned people are notified. | `document`, `thread_id`, `message_id`, `body`, `mentions` |
| `delete_comment` | write | Deletes one of your own messages; the page's owner and workspace admins can delete anyone's. Deleting the last message of a thread deletes the thread (`thread_deleted`). | `document`, `thread_id`, `message_id` |
| `list_waiting_on_me` | read | Open threads across everything you can open that wait on you, newest first, each with its page, link (`url`, ending `#c-<id>`), the words it's about, the last message and why (`waiting_reason`: `assigned`, `mentioned`, `reply`). `view`: `waiting` (default), `assigned` or `mentions`. | `view`, `limit` (1–50, default 20) |
| `suggest_edit` | write | Suggests replacement text for a passage of a page or Markdown document, as a comment thread its editors accept in one click: on an existing thread anchored to text (`thread`), or a new thread on the exact text to replace (`quote`, with an optional `comment` and `block` id). The page doesn't change until someone accepts it. | `document`, `text`, `thread` or `quote` |
| `accept_suggestion` | write | Accepts the open suggested edit on a thread (people who can edit the page): the quoted text is replaced, saved as its own version in the page's history, and the thread is resolved (`resolve: false` keeps it open). While someone has the page open in the editor it waits for them (`applied: false`, `offered: true`). Fails when the text has changed since. | `document`, `thread` |
| `reject_suggestion` | write | Turns down the open suggested edit on a thread (people who can edit the page). The page doesn't change; the suggestion stays in the thread, marked as not used. On your own suggestion it withdraws it. | `document`, `thread` (its id or `#c-` link) |
| `withdraw_suggestion` | write | Takes back your own open suggested edit. Someone else's can only be rejected, by an editor. | `document`, `thread` |
| `summarize_discussion` | read | What the comment threads on a page decided, what's still open and who they're waiting on, each line with its thread ids (open threads and those resolved in the last 30 days). Uses AI within fair-use limits; the same summary comes back until the discussion changes (`refresh: true` asks again). | `document` |

### Files and uploads

For files up to 2 GB that live on the machine where the assistant can run shell commands. If the assistant runs on your computer, the local server's `upload_file` and `replace_file` are simpler.

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `create_upload` | write | Starts an upload of a new file, or of a replacement for an existing one (`target_slug`). Returns signed part addresses and the exact shell commands (`split` and `curl`) that send the file straight to storage. | `file_name`, `size_bytes`, `sha256`; `target_slug`, `content_type`, `title`; for new files `access`, `password`, `workspace`, `folder`, `slug` |
| `complete_upload` | write | Finishes the upload: Markdrop checks the size and SHA-256, then publishes the file or swaps it in as a new version. Returns the link, or `verifying` for a large file. Safe to call again. | `upload_id`, `parts` (optional) |
| `get_upload_status` | read | State of an upload: `uploading` (with parts received), `verifying`, `done` (with the link and version), `failed`, `expired` or `cancelled`. | `upload_id` |
| `get_file_info` | read | A file's type, size, SHA-256, current version and, for video or audio, duration, dimensions, poster and download links. | `document` |
| `list_file_versions` | read | The kept versions of one of your files, newest first, marking the current one. Up to five are kept. | `document` |
| `restore_file_version` | write | Makes an earlier version current again, as a new version. Nothing is deleted. | `document`, `version` |
| `set_captions` | write | Adds or replaces a video's captions from a `.vtt` or `.srt` file's text (the player shows them; search and `ask_documents` read the video by minute), or removes them. | `document`, `file_name`, `content`, `remove` |

Zipped websites can't be uploaded with `create_upload`; use [markdrop.in/upload](https://markdrop.in/upload). An image that goes inside a page isn't a file of its own: add it with `create_page_image_upload` (see [Pages](#pages)).

### Analytics

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `get_document_stats` | read | Views, unique readers, read depth, top referrers and the last view of a document you own. | `document` |
| `get_document_analytics` | read | How a document or file you own is doing: views, people, top sources and what the dashboard noticed. For video and audio: how many are still watching at 0:30, 25%, 50%, 75% and the end, where most leave, and playback health. For Markdown: how far readers get section by section and what they copy and click. For PDFs: how many reach each page. For pages and Markdown documents, also their comment threads (open, resolved, time to a first reply). Returns a short summary you can quote. | `document`, `range` (`7d`, `30d` (default), `90d`, `all`) |
| `comment_insights` | read | How the discussion on a page or Markdown document is going: open and resolved threads, the typical time to a first reply and how many still wait for one, time to resolve, the most-discussed sections and who comments most. Anyone who can see the page's comments. See [Comments](/collaboration/insights-and-exports#insights). | `document`, `range` |
| `get_document_viewers` | read | Every view of a document or file in a period, newest first: who (a signed-in viewer's name and email, or an anonymous "Visitor 3F2A"), when, active time, how far they got, where from (city, region, country, timezone), on what (device, OS and browser with versions, the app it was opened in) and the source (Slack, email, LinkedIn, a Markdrop page…). Plus totals and breakdowns; `by_person` adds one row per person. The owner, and for a workspace item its admins and editors; its viewers get the counts. | `document`, `range`, `who` (`all`, `signed_in`, `anonymous`), `limit`, `include_own`, `by_person` |
| `get_view_timeline` | read | What one view did, in order: sections, pages, slides and spreadsheet tabs with the time on each, what was watched, paused and skipped, scroll depth, links, copies, downloads, prints, questions asked with Ask AI and sign-offs, with the view's details and the same person's other views. | `document`, `view_id` (from `get_document_viewers`) |
| `get_analytics_settings` | read | What an item's analytics collect: each kind (counts, identity, location, device, source, activity, video, pages, downloads) on or off, where its value comes from (the item, its folder, the workspace or your defaults) and whether the workspace locks it. Or a folder's or workspace's defaults, or yours (`account: true`). | one of `document`, `folder` + `workspace`, `workspace`, `account` |
| `set_analytics_settings` | write | Turns kinds of analytics on or off for one item, several (`documents`), a folder, a workspace (with `enforce`) or your defaults. `use_defaults` clears an item's or folder's own settings; `delete` also deletes already collected data of those kinds where they're now off. | the target, `settings`, `use_defaults`, `enforce`, `delete` |
| `analytics_story` | read | What changed in your views over the range and the likely cause (a link, a referrer, a new version, a device or country shift), in 3 to 5 sentences with links to look closer. AI writes it from totals only. Cached for the day. Counts towards your AI limits. | `range` (`7d` (default), `30d`, `90d`), `refresh` |
| `ask_analytics` | read | Answers a question about your own analytics in plain words, like "which PDF did people read most last month?". AI picks from a fixed set of queries Markdrop runs on your own links, then answers briefly with links. Counts towards your AI limits. | `question`, `range` (optional) |
| `content_gaps` | read | What people searched for in a workspace or asked your guides and didn't find in the last 30 days, grouped into pages worth writing, each with a count, an outline and Markdown you can pass to `create_page`. Workspace owners and admins only, or your own personal Guides. Counts towards your AI limits. | `scope` (`workspace:<id>` or `personal`), `refresh` |
| `analyze_document_engagement` | read | AI reads the analytics of a document or file you own and says what to change: 3 to 5 findings, each pointing at the section, moment, page or version. `content` (Markdown and pages: why readers stop, with rewrites), `media` (video and audio: drops, skips and rewatches, chapter ideas), `pages` (PDFs) or `versions` (which version works better, with a confidence Markdrop computes). Needs at least 20 sessions; shares its cache with the dashboard's **Insights**. Counts towards your AI limits. See [AI insights](/analytics/ai-insights). | `document`, `kind` (default: the document's own), `range`, `refresh` |

Your own views are never counted, and views by members of the document's workspace are left out. See [What gets counted](/analytics/what-gets-counted).

### Who's viewing

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `get_viewers` | read | Who has a document or file open right now, as its page shows it: the owner, workspace members and people it was shared with by email by name, everyone else as "Anonymous Otter" and the like. Each with the section, page or video time they're on and whether they're active or away, plus the total. Works for any document you can open. | `document` |
| `set_presence` | write | Turns **Show who's viewing** on or off for a document or file you own. | `document`, `show` (`true` or `false`) |

`get_viewers` follows the same rules as the page: never an email address or account, only the count on an end-to-end encrypted document, and nothing when the owner has turned it off. Asking doesn't add you to the list. See [See who's viewing](/sharing/see-whos-viewing).

### Workspaces and folders

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `list_workspaces` | read | Your workspaces: id, name, your role, custom domains (and whether each is live) and the default access for new documents. | none |
| `list_folders` | read | A workspace's folders as paths (`guides/setup`), with how many items you can open in each, when something in each last changed and whose items are in it. | `workspace` |
| `list_workspace_items` | read | Documents and files you can open in a workspace or one folder of it, newest first, with their links and who owns each. With `previews`, each item also has its opening text as `preview`: what its card shows in the app's Cards view. | `workspace`, `folder`, `query`, `limit` (1–100, default 50), `cursor`, `previews` |
| `list_workspace_members` | read | The members of a workspace you belong to: name, account id and role (`owner`, `admin`, `member`, `viewer`), plus email addresses if you're an admin or the owner. Pending invitations aren't listed. Use the ids to mention people in pages. | `workspace` |
| `add_to_workspace` | write | Files one of your own documents into a workspace (and folder). It keeps its link; its access changes only if you pass `access`. | `document`, `workspace`, `folder`, `access` (`link`, `private`, `workspace`) |
| `remove_from_workspace` | write | Takes a document out of its workspace (its owner or a workspace admin). It keeps its markdrop.in link; a members-only document becomes private. | `document` |
| `create_folder` | write | Creates a folder by path, with any missing parent folders; folders that already exist along the path are used as they are. If the new folder's address is already taken where it goes (by a page, document, file or another folder), nothing is created and the error says what holds it. Pass `on_conflict: "suffix"` to take the next free address (`name-2`) instead. An item you can't open is never named and never blocks you: the folder gets the next free address and the result's `note` says so. | `workspace`, `path`, `on_conflict` (`error` or `suffix`) |
| `rename_folder` | write | Renames a folder (admins and the owner). Its address follows the new name, or `slug`. The folder's old address and the old addresses of everything in it redirect to the new ones. A taken address is refused, as with `create_folder`. | `workspace`, `path` (path or id), `new_name`, `slug`, `on_conflict` |
| `move_folder` | write | Moves a folder with everything in it into another folder, or to the top with `new_parent: "/"` (admins and the owner). Old addresses redirect. Refused if it would nest anything deeper than 8 levels, or if the address is taken at the destination. | `workspace`, `path`, `new_parent`, `on_conflict` |
| `delete_folder` | write | Deletes a folder (admins and the owner). An empty folder goes to the trash. A folder with anything in it is refused, and the error lists what's inside, unless you say what happens to it: `move_to_parent` moves everything up one level and then deletes the folder, and `trash` moves the folder with everything in it to the trash. Either way the trash keeps it for 30 days; bring it back with `restore_document` and the folder's id. | `workspace`, `path`, `contents` (`refuse`, `move_to_parent`, `trash`) |
| `move_to_folder` | write | Moves a workspace document to another folder of the same workspace, or to the top level when `folder` is omitted. | `document`, `folder` |

A folder's path in these tools is its address, like `guides/setup`, as `list_folders` shows it. Its display name and its id work too. When `delete_folder` refuses, the error names the subfolders and the items you can open, and only counts the ones you can't.

### Meetings

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `import_meeting` | write | Turns a meeting into a page in the workspace's **Meetings** folder: an AI summary, decisions, action items (people who are members are @mentioned, as links; meeting imports notify nobody), open questions, topics, and the transcript as a sub-page. Takes the transcript as text, a file as `file_name` + `content_base64` (`.txt`, `.vtt`, `.srt`, `.sbv`, `.docx`), and/or Google Meet's Gemini notes as `notes_text` (used as written; the AI only fills the gaps). No duplicates: a call that's already in the workspace (same name, date and start time) comes back as `duplicate`, and the other half of a call that's already there (the notes for a transcript, or the other way round) is added to it as `attached`. Or pass `drive_url`, a Google Docs or Drive link: Markdrop reads a Doc shared with "anyone with the link" itself, queues a private one for the user's Google Meet script when it's connected to that workspace (`link.status` `queued`), and otherwise says how to give access (`needs_access`). 1:1s and two-person calls are restricted to their attendees. Waits for the summary, which is always in English. See [Meetings](/workspaces/meetings) and [Paste a Google Drive link](/workspaces/meetings-import#paste-a-google-drive-link). | `workspace`, `text`, `notes_text`, `file_name`, `content_base64`, `drive_url`, `title`, `date`, `type`, `restricted` |
| `import_meetings_bulk` | write | Imports many past meetings at once, like [Import past meetings](/workspaces/meetings-import#import-past-meetings) on the website: up to 25 transcripts or Gemini notes per call, as text or files. Each meeting gets its real date (from Google's file name or the text, or the `date` you pass), Google's notes and the transcript of one call become one meeting, recurring meetings get a series, and meetings already in the workspace come back as `duplicate`. Items without a date come back as `needs_date`. `dry_run: true` only reviews; otherwise the rest imports in the background, oldest first. Nobody is notified about their @mentions, as with every meeting import; `notify: true` lets meetings from the last day be posted to your Slack meetings channel. Call it again with `job` to see progress. | `workspace`, `items` (`text`, `notes_text`, `file_name`, `content_base64`, `date`, `title`, `series`), `dry_run`, `notify`, `job` |
| `organize_meetings` | write | Workspace admins: files every meeting the way new ones are filed, a recurring meeting in **Meetings › its series** and anything else in **Meetings › Other meetings**, setting the series where nobody did and putting spellings of one series together ("Daily Syncup", "Daily Sync Up"). Transcripts move with their meetings, and meetings without a cover get their series' cover. It runs in the background: the tool waits up to about 50 seconds and says how many meetings moved, how many series there are and how many covers it set; in a big workspace it returns the progress so far (`state: running`), and calling it again follows the same run. Safe to run again. | `workspace` |
| `list_meetings` | read | The meetings of a workspace you can open, newest first: title, date, series, type, attendees, a line of its summary, how many decisions, action items and open questions it has, link, and how each came in (`manual`, `auto` from the Google Meet script, or `mcp`). `query` matches titles, series and attendees' names. A page at a time: when the answer has a `next_cursor`, pass it as `cursor` (with the same filters) for the next page. | `workspace`, `query`, `series` (or `none`), `since`, `until` (YYYY-MM-DD), `source` (`manual`, `auto`, `mcp`), `limit`, `cursor` |
| `get_meeting` | read | One meeting: its page's Markdown and, with `transcript: true`, its transcript lines (400 at a time), each with a link to that moment. | `meeting` (an id from `list_meetings`, or the page's link), `transcript`, `from_segment` |
| `ask_meetings` | read | Asks one meeting, or every meeting in a workspace you can open. AI answers in English, says when and in which meeting each point was made, and cites the moments with links. Across meetings you can scope it to a series and a date range; otherwise a series or period named in the question is used ("in Daily Standups last month"). Counts towards your AI limits. | `question`, `meeting` or `workspace`, `series`, `since`, `until` |
| `meeting_context` | read | What the team decided and discussed in meetings about a topic, for writing a PRD, spec or feature document: decisions, action items (owner, due, open or done), open questions and topics recorded in the workspace's meetings you can open, best match first. Each has its date, meeting and series, a link to the moment in the transcript, and `markdown`, a dated, cited line ready to paste into a page. Give `topic` and `workspace`, or `page` (its title and headings are the topic). No AI call. See [Meeting memory while writing](/pages/meeting-memory). | `topic`, `workspace`, `page`, `kinds` (`decision`, `action_item`, `open_question`, `topic`), `limit` |
| `meetings_connection` | read | Whether meetings are imported automatically into a workspace ([Connect Google Meet](/workspaces/meetings-auto-import)): who connected it, since when, how many meetings it imported and when it last did, how the script's last run went, how many meetings are `waiting` for Google to fill in Gemini's notes or the transcript, whether [Check now](/workspaces/meetings-auto-import#check-for-new-meetings) is on (`check_now`) and whether the script is out of date (`needs_update`). It never returns the token, the script or the Check now address; you connect and disconnect on the website. | `workspace` |
| `check_meetings_now` | write | Checks for new meetings now ("Check for new meetings" on the Meetings page): the Google Meet scripts connected to the workspace run right away instead of at their next run (every 5 minutes), and the transcripts and Gemini notes Google has finished arrive as meetings. Takes up to about 50 seconds; once a minute per workspace; members only. Works once whoever connected Google Meet [turned Check now on](/workspaces/meetings-auto-import#check-for-new-meetings). | `workspace` |

### Team

What each member of a workspace is doing, from [Team memory](/workspaces/team). These need the workspace to have Team memory on, and work for its members only. Every line comes from a meeting or page you can open, with a link to it. No AI call: they cost nothing.

The write tools follow the website's rules: you change only your own status, focus and lines (a line's `id` comes from `get_person_profile` with `person: me`), and only workspace admins make groups or send the weekly summary.

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `list_team` | read | The Team board: each member's status (On track, Blocked, Waiting on someone, Quiet lately, or the status they set), what they're on now, targets with due dates and open items, the current blockers, and recurring projects. | `workspace` |
| `get_person_profile` | read | One member's Team page: status, their focus note, what they're working on, targets, recent updates, open action items, decisions they own, recent documents and meetings, each line with its source. Use it for "what is Abhishek working on?". | `workspace`, `person` (a name, a first name only one member has, an email, an id, or `me`) |
| `get_project_status` | read | A recurring project: its latest status, who is on it, what's being worked on, decisions, open items and blockers, recent updates. | `workspace`, `project` (its name) |
| `list_team_groups` | read | The workspace's groups (the board's filters) with their members; for admins also suggested groups, one per recurring meeting series. | `workspace` |
| `set_my_status` | write | Sets your own status ("On leave till Monday"), with an optional emoji and end time. It shows instead of the status Team works out until it ends; `status: ""` clears it. | `workspace`, `status`, `emoji`, `until` (ISO date-time) |
| `set_focus_note` | write | Sets your "What I'm focused on" note, which tops your card and page; `text: ""` clears it. | `workspace`, `text` |
| `mark_team_item_done` | write | Marks one of your action items or targets done: it leaves your open items, the board and This week. `done: false` undoes it. | `workspace`, `line_id`, `done` |
| `hide_team_line` | write | Hides a line about you for everyone; it stays hidden when its source is read again. `hidden: false` shows it again. | `workspace`, `line_id`, `hidden` |
| `correct_team_line` | write | "This is wrong" on a line about you, with the right version (optional); `clear: true` removes the correction. | `workspace`, `line_id`, `text`, `clear` |
| `save_team_group` | write | Admins: creates a group, or renames one or changes its members (`group_id`). Members by name, email or id. | `workspace`, `group_id`, `name`, `members` |
| `delete_team_group` | write | Admins: deletes a group; its members stay in the workspace. | `workspace`, `group_id` |
| `send_weekly_summary_now` | write | Admins: sends the weekly summary now ("Week of Nov 9: last week's highlights and what's due": last week's highlights, decisions and meetings, this week's due items, overdue, blocked right now; only from what the whole team can open) to the Slack meetings channel and the admins' email. A few times an hour at most. | `workspace` |

### Teams

A workspace's [teams](/teams/overview): each has its own pages, meetings, memory and Ask. Everything is filtered for you: a private team you're not in shows only its name and weekly brief (workspace admins see all of it). No AI call. See [Teams for AI apps](/teams/for-ai-apps).

| Tool | Kind | What it does | Arguments |
| --- | --- | --- | --- |
| `list_teams` | read | The workspace's teams: name, open or private, size, and whether you're in it. | `workspace` |
| `get_team` | read | A team's home: its latest brief, members, recent pages, meetings and projects. A private team you're not in: its name and brief. | `workspace`, `team` (id, slug or name) |
| `get_team_brief` | read | A team's weekly brief (this week's, or `week`). Every workspace member can read it; hidden lines only reach its leads. | `workspace`, `team`, `week` |
| `list_projects` | read | Cross-team projects you can open (`team`: only that team's). | `workspace`, `team` |
| `create_team` | write | Workspace admins: a new open or private team, with its leads and members. | `workspace`, `name`, `visibility`, `description`, `leads`, `members` |
| `update_team` | write | Leads and admins: name, description, Slack channel, comment posts to the channel (`slack_comments`), Jira projects and digest; admins also open or private. | `workspace`, `team`, … |
| `add_team_members` | write | Leads and admins add workspace members (names, emails or ids); anyone can add themselves to an open team. | `workspace`, `team`, `people` |
| `remove_team_members` | write | Leads and admins remove people; anyone can remove themselves (`"me"`). | `workspace`, `team`, `people` |
| `move_to_team` | write | Puts a document, page or file into one team's space, or back to company-wide (`team: "company"`). | `document`, `team` |
| `share_to_team` | write | Adds a team to an item's teams (it then belongs to several), or takes one off (`remove: true`). | `document`, `team`, `remove` |
| `edit_team_brief` | write | Leads and admins: change a brief line's text, hide or show it, or add a line. | `workspace`, `team`, `line_id`, `text`, `hidden`, `add` |
| `create_project` | write | A project space shared by several teams ("Q4 launch"). | `workspace`, `name`, `teams`, `description` |
| `route_meeting` | write | Says which teams a meeting belongs to; its page and transcript follow. | `meeting`, `teams` |

`search`, `ask_documents`, `ask_meetings`, `list_team`, `get_person_profile`, `get_project_status`, `list_workspace_items` and `list_meetings` take a `space`: `team:<id>`, `project:<id>`, `company` (company-wide items only) or `all` (the default: everything you can read).

### Slack

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `slack_status` | read | Whether a workspace is connected to [Slack](/integrations/slack): which Slack workspace, the channel meeting notes go to and whether new meetings are posted there on their own, whether the connection needs reconnecting, how many people linked their Slack account, whether yours is linked (and which direct messages you get), and whether everyone in a meeting gets their own action items as a direct message after it (`action_item_dms`, and your own switch `me.action_items`). Any member can ask. It never returns a token; connecting Slack, choosing the channel and linking an account are done on the website. | `workspace` |
| `post_meeting_to_slack` | write | Posts a meeting's summary, decisions and action items, each with a **Done** button, to its workspace's Slack meetings channel: again, or for the first time (meetings from [Import past meetings](/workspaces/meetings-import#import-past-meetings) are never posted on their own). Needs edit access to the meeting's page. A meeting restricted to its attendees, or one not everyone in the channel may open, is never posted; the same meeting is posted at most once a minute. | `meeting` (an id from `list_meetings`, or the page's link) |

### Jira

Issue details only ever come through your own Atlassian account, so you only see issues you could open in Jira. Connecting Jira and your account is done on the website. See [Jira](/integrations/jira).

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `jira_status` | read | Whether a workspace is connected to a Jira site: the site, the default project and issue type, the projects on Team, and whether your own Atlassian account is connected and reaches the site. Never returns a token. | `workspace` |
| `create_jira_issue` | write | Drafts or creates a Jira issue from an item on a page or meeting page (an action item, decision or open question, by its block id or its words) or from text you pass. `draft: true` (the default) returns the AI draft (summary, description, issue type, priority, assignee, due date, labels) and creates nothing; `draft: false` creates it as you, with your fields over the draft, and links it to the item (a live chip, and a to-do stays in step with the issue). | `page`, `item` or `text`, `draft`, `project`, `issue_type`, `summary`, `description`, `priority`, `assignee` (a member: name, email, id or `me`), `due`, `labels` |
| `link_jira_issue` | write | Links an existing issue (a key like PAY-123, or its link) to an item on a page: the item shows a live chip, and a to-do stays in step with the issue. Needs edit access to the page, and your Atlassian account must be able to open the issue. | `page`, `item`, `issue` |
| `list_jira_issues` | read | The workspace members' issues in the projects on Team (updated in the last 30 days), for one person, one project or a status: `todo`, `in_progress`, `done`, `overdue`, `blocked`. | `workspace`, `person`, `project`, `status`, `limit` |
| `transition_jira_issue` | write | Moves an issue to `done`, `todo` or `in_progress` (the first matching step of its workflow), as you. To-dos linked to it follow. | `workspace`, `issue`, `to` |
| `insert_jira` | write | Puts a Jira issue on a page as an inline chip or a card, or a live list of issues (a JQL query, a project or a saved filter), at the end or after a heading. Readers see live details only through their own Jira; everyone else sees the key and title. See [Jira in pages](/collaboration/jira-in-pages). | `document`, `issue`, `as` (`chip`, `card`, `list`), `jql` or `project` or `filter`, `cols`, `limit`, `title`, `site`, `after_heading` |
| `update_jira_issue` | write | Changes an issue as you: a workflow step by its name or the status it leads to (with the fields the step needs), the assignee (a name, `me`, or `null`), a comment added in Jira, the title, priority or due date. Pages showing the issue update for their readers. | `issue`, `transition`, `fields`, `assignee`, `comment`, `summary`, `priority`, `due`, `site`, `page` |
| `list_jira_transitions` | read | The workflow steps you can take on an issue now, each with the fields it needs (required ones first, with their allowed values). | `issue`, `site`, `page` |
| `thread_to_jira` | write | Drafts or creates a Jira issue from a comment thread. `draft: true` (the default) returns the draft from the discussion and creates nothing; `draft: false` creates it as you, with your fields over the draft, and links the thread to it (the issue links back to the thread). `put_chip: true` also puts the issue's chip right after the text the thread is about, when you can edit the page. A thread has one issue. | `document`, `thread`, `draft`, `project`, `issue_type`, `summary`, `description`, `priority`, `assignee`, `due`, `labels`, `put_chip` |

### Peer-to-peer shares

The hosted server can't send or receive files; that needs the [local server](/ai/local-mcp). It can see your shares.

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `list_shares` | read | Peer-to-peer shares you started while signed in (in the browser, or from the CLI with your API token), newest first: whether each is live, recipients connected now and downloads finished in a browser. A share is listed once its first recipient has connected. | `limit` (1–50, default 20), `live_only` |
| `get_share_status` | read | Whether a share link's sender is online and people can join. For your own shares, also what is shared and how many have downloaded. | `link` |

## Local server tools

These run on your computer, inside `markdrop mcp`. They have no permissions to approve; the file, workspace and page tools act as the owner of the server's API token: `MARKDROP_TOKEN` in its environment, or else the token saved by `markdrop login`. See [Add the local MCP server](/ai/local-mcp).

### Publish files from disk

| Tool | Token | What it does | Main inputs |
|---|---|---|---|
| `upload_file` | Yes | Publishes a file from this computer (video and audio up to 2 GB) and returns its link. Resumes when called again with the same arguments. | `path`, `title`, `access` (`link`, `private`, `password`, `workspace`; default `link`, or `password` when a password is given, else `workspace` when a workspace is), `password`, `workspace`, `folder`, `slug` |
| `replace_file` | Yes | Replaces the file behind an existing link with a file from this computer. Link, access, title and views stay; the previous version is kept. | `document`, `path`, `title` |
| `list_file_versions` | Yes | A file's versions, newest first. Up to five are kept. | `document` |
| `restore_file_version` | Yes | Makes an earlier version current again, as a new version. | `document`, `version` |
| `get_file_info` | Yes | Link, type, size, SHA-256, version, dates and video or audio details. | `document` |

Results of `upload_file` and `replace_file` carry `url`, `markdrop_url`, `slug`, `version`, `size_bytes` and `sha256`.

### Workspaces

| Tool | Token | What it does | Main inputs |
|---|---|---|---|
| `list_workspaces` | Yes | Your workspaces: id, name, role, custom domains (verified, live, default) and default access. | none |
| `list_folders` | Yes | A workspace's folders: id, name, path, depth and item count. | `workspace` |

### Pages and files on disk

| Tool | Token | What it does | Main inputs |
|---|---|---|---|
| `upload_page_image` | Yes | Uploads an image file from this computer (PNG, JPEG, GIF or WebP, up to 10 MB) to a page and returns `asset` and the Markdown that shows it. Optionally makes it the cover or icon, or adds it at the end of the page. | `document`, `path`, `alt`, `set_as` (`cover`, `icon`), `append` |
| `export_page` | Yes | Saves a page as a file on this computer: Markdown, one HTML file, or a zip with its images (and sub-pages). Returns `path`, `filename` and `bytes`. Never replaces a file unless asked. | `document`, `format` (`md`, `html`, `zip`), `include_subpages`, `path` (a file or folder; default `~/Downloads/Markdrop`), `overwrite` |

### Share peer to peer

| Tool | Token | What it does | Main inputs |
|---|---|---|---|
| `share_files` | No | Shares files or folders and returns a `markdrop.in/share` link. Several paths or a folder go as one zip. Serves one recipient at a time until stopped or the app closes. | `paths` (1–100) |
| `share_status` | No | State (`waiting`, `connecting`, `transferring`, `done`, `stopped`, `error`), progress, recipients served, saved paths and the last error of each share and download in the session. | `share_id` (a share id or a receive id; omit for everything) |
| `stop_share` | No | Stops a share; anyone downloading is told the sender stopped. Given a receive id, cancels that download. | `share_id` |
| `receive_share` | No | Downloads a share link into `~/Downloads/Markdrop` or a folder you name, in the background. Never overwrites. | `link`, `directory` |

With a token (`MARKDROP_TOKEN` or the one saved by `markdrop login`), shares started by `share_files` are listed under your account, so the hosted server's `list_shares` shows them.

## Same name, two servers

`get_file_info`, `list_file_versions`, `restore_file_version`, `list_workspaces` and `list_folders` exist on both servers and do the same thing. If an app has both servers, either may answer. `upload_page_image` and `export_page` share a name but not their inputs: the hosted ones take the image as base64 and return the export as text or a link; the local ones read and write files on your computer.
