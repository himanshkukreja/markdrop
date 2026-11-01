---
title: Import from GitHub and keep in sync
nav: Import from GitHub
description: Bring a repository's docs into a guide (Markdown, GitBook, Mintlify, Docusaurus or MkDocs), then keep it in sync so every push updates the guide.
updated: 2026-11-02
prerequisites: [/guides/create-a-site]
keywords: [github, git, repository, import, sync, push, docs as code, markdown, mdx, gitbook git sync, mintlify, docusaurus, mkdocs, github app, migrate]
---

Point Markdrop Guides at a GitHub repository and it copies the docs in it into a guide: every page, the sidebar, images and files, and old addresses. Turn on **Keep in sync** and every push to the branch updates the guide. Markdrop only reads your repository: it never commits or changes anything there.

## What it reads

Markdrop Guides works out the format from the folder's files. You can also choose it yourself under **Format**.

| Format | How it's recognised | What becomes the sidebar |
| --- | --- | --- |
| **Markdown folder** | Any folder of `.md` or `.mdx` files | The folders: each top-level folder is a group. `README.md` or `index.md` is the home page. Front matter `title`, `order`, `sidebar_position` and `nav_order` are used. |
| **GitBook (Git Sync)** | `.gitbook.yaml` or `SUMMARY.md` | `SUMMARY.md`: its `##` headings are groups, its links are the pages in order. |
| **Mintlify** | `docs.json` or `mint.json` | The `navigation` groups, and its tabs as the guide's header tabs. |
| **Docusaurus** | `docusaurus.config.js` (or `.ts`) | `sidebars.js`, read as text (never run), or the folders with `_category_.json` when the sidebar is generated. |
| **MkDocs** | `mkdocs.yml` | The `nav:` list, or the folders when there's none. |

For a format with a config file, choose the folder that holds the config (like `website` for a Docusaurus site in `website/`). Markdrop finds the pages from there.

Each format's own blocks become the guide's blocks:

| In the repository | In the guide |
| --- | --- |
| Mintlify `<Note>`, `<Tip>`, `<Warning>`, `<Info>`; Docusaurus `:::note`, `:::tip`, `:::caution`; MkDocs `!!! note`; GitBook `{% hint %}` | [Callouts](/guides/editor#the-slash-menu) |
| `<Tabs>` and `<Tab>`, `<CodeGroup>`, Docusaurus `<TabItem>`, MkDocs `=== "Tab"`, GitBook `{% tabs %}` | Tabs |
| `<Steps>` and `<Step>`, GitBook `{% stepper %}` | Steps |
| `<CardGroup>` and `<Card>`, GitBook `{% content-ref %}` | Cards |
| `<Accordion>`, `<details>`, MkDocs `??? note` | Expandable sections |
| Images and PDFs in the repository | The guide's own files |
| YouTube, Vimeo and Loom embeds | Videos |

Anything without a match keeps its text, and the import report lists it under **Blocks converted approximately**.

## Connect GitHub

Public repositories import without connecting anything. To import a **private** repository, or to **keep a guide in sync**, install the **Markdrop Guides** GitHub app on the repositories you choose.

The app asks for two read-only permissions:

- **Contents: read-only**, to download the docs at each push.
- **Metadata: read-only**, which every GitHub app has, to list the repositories you chose.

It gets no write access, so it can't commit, open pull requests or change settings. GitHub tells the app when you push, which is how a sync starts.

::::steps
### Choose Connect GitHub
On **New guide** (or a guide's **Settings › GitHub**), choose **Connect GitHub**. You need to be a Guides admin of the workspace.

### Install the app on GitHub
Pick the account or organisation and the repositories the app can read. Only an owner of an organisation can install apps on it; GitHub can send them a request.

### Come back to Markdrop
GitHub sends you back to Markdrop Guides, which checks with GitHub that your account can open that installation and connects it to the workspace. Guides admins of the workspace can then import from its repositories.
::::

The app is already installed on the account? Choose **Already installed? Link it** instead. To stop Markdrop reading an account, remove the app on GitHub (**Settings › Applications**), or change which repositories it can read there.

## Import a repository

::::steps
### Start a new guide
Choose **New guide**, pick where it lives, and under **How do you want to start?** choose **Import from GitHub**.

### Pick the repository
Under **Your repositories**, choose a repository the app can read. For a public repository without the app, choose **Public repository** and paste its address, like `https://github.com/acme/docs`. A link to a folder (`…/tree/main/docs`) opens that folder.

### Choose the branch and folder
The **Branch** starts at the default branch. **Folder** suggests the folders that hold docs; choose **Other folder…** to type another. The detected **Format** shows beside it.

### Check what comes across
The preview shows how many pages the folder has and the sidebar groups the guide will get, with anything worth knowing, like an OpenAPI file it found.

### Choose what pushes do
Turn on **Keep in sync** and choose **Update drafts** (each push updates the drafts; you publish when ready) or **Publish automatically** (each push is published after it syncs). Then name the guide and choose **Import**.
::::

![The GitHub repository panel on New guide: Your repositories for the acme organization with acme/docs selected, branch main, folder docs (Mintlify, 9 pages), format Auto (Mintlify), What the import brings with 9 pages in 4 groups and an OpenAPI file found, and Keep in sync on with Update drafts chosen.](/docs-assets/guides/import-from-github/import-form.webp)

The import screen shows four steps: downloading the repository, converting pages, copying images and files, and saving as drafts. You can close it: the import keeps running. When it's done, check what **Needs a look before you publish**, as for a [GitBook import](/guides/import-from-gitbook#check-the-report). Nothing is public until you publish.

![The finished import from acme/docs: four completed steps (commit 8d05730; 4 groups, 8 pages; 5 images; 2 old links kept working), Kept in sync with Update drafts, the OpenAPI file offered as the API reference, release notes found, and one row under Needs a look before you publish.](/docs-assets/guides/import-from-github/import-done.webp)

If the repository has an OpenAPI file (a Mintlify site's `openapi` setting, or a file named `openapi.yaml`), the import screen and **Settings › GitHub** offer **Use as API reference**. See [API reference](/guides/api-reference).

## Keep it in sync

With **Keep in sync** on, every push to the branch that changes something in the folder updates the guide, usually within a minute or two:

- **Changed files** update their pages. Each sync is a new version in the page's [history](/guides/history), so nothing is lost.
- **New files** become new pages, in the place the sidebar config gives them.
- **Removed files** remove their pages.
- **A renamed or moved file** keeps its page and history when its text stays mostly the same (as Git judges a rename), and the old address redirects to the new one once it was published. The same goes for a page whose address changes because of its front matter (a new `slug`, say).
- **The same file is always the same page**, so a sync never makes duplicates, and a page whose file didn't change isn't touched.
- **Update drafts**: the changes wait as drafts, like an edit in the editor. **Publish automatically**: the guide is published after the sync, as the person who connected the repository. Publishing counts toward the [daily publish limit](/guides/publishing).

Pushes to other branches, and pushes that change nothing in the folder, are ignored. A guide syncs at most 50 times a day.

### Editing in the editor

GitHub is the source of truth for the pages it brought:

- A page from GitHub shows **This page comes from GitHub** with its repository and file, and **Edit on GitHub**. You can still edit it here, but the next push that syncs replaces your edit (the page's history keeps it).

![The editor on a page from GitHub: the banner This page comes from GitHub, acme/docs › docs/quickstart.mdx, Changes here are replaced by the next push, with Edit on GitHub; the page tree marks each synced page with a GitHub icon.](/docs-assets/guides/import-from-github/synced-page.webp)
- Pages you add in the editor stay yours: a sync never changes or removes them, and keeps them in the sidebar where you put them. A file whose address belongs to one of your pages is left out of the sync, and the sync history says so.
- Design, settings, the changelog and the guide's domains are yours too: a sync only changes pages and the sidebar.

### The GitHub settings

A connected guide's **Settings › GitHub** shows the repository, branch and folder, the last commit it synced and when, and:

- **Sync now**, to sync the latest commit without waiting for a push. Editors and admins can use it.
- **Keep in sync** and what pushes do (**Update drafts** or **Publish automatically**), the branch and the format. Admins can change them.
- **Sync history**: each sync with what started it (the first import, a push and who pushed, or **Sync now**), the commit, how many pages were added, updated and removed, and any problem.
- **Disconnect**: syncing stops, and the pages stay in the guide as ordinary pages you edit here.

![Settings › GitHub for a connected guide: acme/docs › main › docs, In sync, last sync 8b195c2, Keep in sync on with Update drafts, the branch and format, the OpenAPI offer, and a sync history with a push by ada (1 new, 1 updated) and the first import (8 new).](/docs-assets/guides/import-from-github/settings-github.webp)

To connect a guide you made another way, open **Settings › GitHub**, choose the repository and folder, and choose **Connect**. The first sync takes over pages at the same addresses, so a guide's home page becomes the repository's.

## Public repositories without the app

A public repository can be imported once without installing anything. It can't stay in sync, because GitHub only tells Markdrop about pushes to repositories the app is installed on. **Sync now** in **Settings › GitHub** still brings in the latest commit whenever you choose. GitHub limits how often a repository can be read without the app; if you see **GitHub asked us to slow down**, wait a few minutes or connect GitHub.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| **Not set up yet** | Private repositories and sync aren't available on this Markdrop server yet. Public repositories still import. |
| **We couldn't find that repository** | Check the address. For a private repository, install the app on its account and choose it under **Your repositories**. |
| **No repositories yet** | The app can't read any repositories on that account. Choose some on GitHub (**Configure** on the app), then come back. |
| **No pages in this folder** | Markdrop imports `.md` and `.mdx` files. Pick the folder that holds them, or the one with the config file, or choose the format. |
| **Sync failed** | Open **Settings › GitHub**: the sync history says why. Fix it in the repository and push, or choose **Sync now**. |
| **The app is suspended on this account** | Someone suspended the Markdrop Guides app on GitHub. Unsuspend it there and syncing resumes with the next push. |
| A push didn't update the guide | Check that it was to the connected branch, changed a file inside the folder, and that **Keep in sync** is on. |
