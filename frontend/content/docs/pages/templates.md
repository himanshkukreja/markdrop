---
title: Templates
description: Start a page from a built-in template, from one your workspace saved, or from one of your own. Save any page as a template, with its sub-pages and images.
updated: 2026-11-04
prerequisites: [/pages/overview]
keywords: [template, templates, workspace templates, save as template, personal templates, placeholders, "{{date}}", "{{author}}", "{{title}}", manage templates, prd, spec, runbook, meeting notes, release notes, how-to, qa, test plan, save_page_as_template, list_page_templates]
---

When you make a page, Markdrop offers templates: the built-in ones, your workspace's and your own. A template only fills in the page's first draft. After that the page is yours to change, and the template is never applied again.

## Use a template

1. Choose **New page** in a workspace or folder, **Create** › **Page**, or **Add a sub-page** inside a page.
2. Pick a template. Your workspace's templates come first, then yours, then the built-in ones. Choosing one shows a preview.
3. Type a title, or leave it empty to use the template's name, and choose **Create page**. Double-clicking a template creates the page straight away.

A blank page also offers the built-in templates as chips under the title until you start typing.

## Built-in templates

| Template | What it's for |
| --- | --- |
| Feature guide / release notes | What shipped, who it's for and how to use it |
| Customer-facing how-to | Step-by-step help for your customers |
| QA test plan | Scope, test cases and sign-off |
| Product spec | Problem, goals, requirements and open questions |
| Meeting notes | Agenda, notes and action items, dated today |
| Runbook | Symptoms, checks, the fix and who to escalate to |
| Blank | An empty page |

## Save a page as a template

Any page can become a template: a weekly sync, an incident review, an onboarding checklist.

1. Open the page and choose **⋯** › **Save as template**.
2. Choose who can use it:
   - **Everyone in** your workspace: it appears in the New page gallery for the workspace's members.
   - **Just me**: only you see it.
3. Give it a name, an optional description and an emoji.
4. If the page has sub-pages, turn on **Include sub-pages** to bring them along. Only the sub-pages you can open are copied.
5. Choose **Save template**.

The template is a copy. Changing the original page later doesn't change the template, and editing the template doesn't change the page you saved it from. Images in the page are copied with it.

### Placeholders

Write these anywhere in a template, in its title or in its sub-pages. Each new page gets them filled in:

| Placeholder | Becomes |
| --- | --- |
| `{{date}}` | The day the page was made, like November 4, 2026 |
| `{{author}}` | The name of the person who made the page |
| `{{title}}` | The new page's title |

For example, a template with `Notes by {{author}}, {{date}}` makes a page that starts with "Notes by Riya, November 4, 2026".

## Edit and manage templates

A template is a page. To change what new pages start with, open the template and edit it like any page. A note at the top says it's a template, and it has **New page from it** and **Manage templates**.

In the New page gallery, **Manage** opens **Manage templates**:

- **Edit** opens the template page.
- **Rename** changes its name, description and emoji.
- **Delete** removes the template and its sub-pages. Pages already made from it stay as they are.
- **Drag** a template by its handle to change the order the gallery shows. On a keyboard, focus the handle, press Space, move with the arrow keys and press Space again.

## Who can do what

| | Workspace viewer | Workspace member | Workspace admin or owner |
| --- | --- | --- | --- |
| See and use the workspace's templates | No | Yes | Yes |
| Save a page as a workspace template | No | Yes | Yes |
| Edit a template page | No | Yes | Yes |
| Rename or delete a template | No | Ones they saved | Yes |
| Reorder the workspace's templates | No | No | Yes |

People outside the workspace never see its templates. Your personal templates are yours alone: nobody else can see, use or change them.

Templates never appear in lists, search, the sidebar, a folder page on your workspace's domain, or an AI app's document search. A page made from a template is an ordinary page: it lands where you made it and gets that place's access, and its images follow its access.

## From an AI app

AI apps connected to Markdrop can:

- list every template you can use, built-in, workspace and personal, with `list_page_templates`;
- start a page from one with `create_page` and the template's `id`;
- save a page as a template with `save_page_as_template`.

See [Tools for AI apps](/ai/tools).
