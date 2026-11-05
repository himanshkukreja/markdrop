---
title: Templates
description: Start pages from built-in, workspace or personal templates. Use any page as a template, with its sub-pages and images, and give a folder a default.
updated: 2026-11-05
prerequisites: [/pages/overview]
keywords: [template, templates, workspace templates, use as template, save as template, default template, folder template, "{{folder}}", personal templates, placeholders, "{{date}}", "{{author}}", "{{title}}", manage templates, prd, spec, runbook, meeting notes, release notes, how-to, qa, test plan, save_page_as_template, list_page_templates]
---

When you make a page, Markdrop offers templates: the built-in ones, your workspace's and your own. A template only fills in the page's first draft. After that the page is yours to change, and the template is never applied again.

## Use a template

1. Choose **New page** in a workspace or folder, **Create** › **Page**, or **Add a sub-page** inside a page.
2. Pick a template. Your workspace's templates come first, then yours, then the built-in ones. Choosing one shows a preview. In a folder with a [default template](#a-folders-default-template), that one is already chosen: pick **Blank** or another template if you want something else.
3. Type a title, or leave it empty to use the template's name, and choose **Create page**. Double-clicking a template creates the page straight away.

On a phone or tablet the gallery opens on the templates, not in the title, so the keyboard doesn't cover them; tap **Title** when you want to type one. On a phone the templates are one list, each with its icon beside its name.

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

## Use a page as a template

Any page can become a template: a weekly sync, an incident review, a PRD, an onboarding checklist.

1. Open the page and choose **⋯** › **Use as template**.
2. Choose who can use it:
   - **Everyone in** your workspace: it appears in the New page gallery for the workspace's members.
   - **Just me**: only you see it.
3. Give it a name, an optional description and an emoji.
4. If the page has sub-pages, turn on **Include sub-pages** to bring them along. Only the sub-pages you can open are copied.
5. Choose **Save template**.

It then shows in **New page** and **Add a sub-page** for everyone you chose, in a section above the built-in templates.

The template is a copy. Changing the original page later doesn't change the template, and editing the template doesn't change the page you saved it from. Images in the page are copied with it.

### Placeholders

Write these anywhere in a template, in its title or in its sub-pages. Each new page gets them filled in:

| Placeholder | Becomes |
| --- | --- |
| `{{date}}` | The day the page was made, like November 4, 2026 |
| `{{author}}` | The name of the person who made the page |
| `{{title}}` | The new page's title |
| `{{folder}}` | The name of the folder the new page is in (nothing when it isn't in one) |

`{{author}}` is the display name of whoever makes the page, or of the person whose AI app makes it. For example, a template with `Notes by {{author}}, {{date}}` makes a page that starts with "Notes by Riya, November 4, 2026".

## A folder's default template

A folder can have a default template, so every new page there starts the same way. For example, **New page** in `product-hub/02-prds` can start from your PRD template.

1. Open the folder and choose **New page**.
2. Under the templates, **New pages in** the folder **start from**: choose a template, or **A blank page** for none. Workspace admins see this.

The default is only a starting point: whoever makes a page can still pick **Blank** or another template. A page that an AI app makes in the folder without naming a template or giving its own content starts from the default too. If the default template is deleted, new pages there start blank again.

The default can be one of the workspace's templates or a built-in one. It applies to pages made directly in that folder, not in the folders inside it.

## Edit and manage templates

A template is a page. To change what new pages start with, open the template and edit it like any page. A note at the top says it's a template, and it has **New page from it**, **Manage templates** and **Make it a page again**.

Editing a template never changes pages already made from it. Only pages made after the change get the new version.

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
| Set a folder's default template | No | No | Yes |

People outside the workspace never see its templates. Your personal templates are yours alone: nobody else can see, use or change them.

Templates never appear in lists, search, the sidebar, a folder page on your workspace's domain, or an AI app's document search. A page made from a template is an ordinary page: it lands where you made it and gets that place's access, and its images follow its access.

## Limits

- Up to 200 templates per workspace, and 200 of your own.
- Up to 100 sub-pages come with a template.
- A name up to 120 characters, a description up to 300, and an emoji as its icon.
- Copied images count towards the storage of the person who owns the new page. A page holds up to 500 images of up to 10 MB each.

## From an AI app

AI apps connected to Markdrop can:

- list the templates you can use, each with its `id`, with `list_page_templates`. Give it a `workspace` to list only that workspace's templates and the built-in ones;
- start a page from one with `create_page` and the template's `id` or the template page's slug;
- use a page as a template with `save_page_as_template`, which saves a copy;
- turn a page itself into a template, or back, with `set_page_properties` and `template: true` or `false`;
- set a folder's default template with `set_folder_default_template`.

See [Tools for AI apps](/ai/tools).
