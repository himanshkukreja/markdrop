---
title: Write pages from the terminal
nav: Pages
description: Create, read, edit and export Markdrop pages with markdrop page, add images from your disk, change a page's link, and bring back an earlier version.
updated: 2026-11-04
prerequisites: [/cli/install, /cli/login-and-tokens]
since: CLI 0.6.0
keywords: [markdrop page, page new, page get, page update, page append, page props, page image, page versions, page restore, link set, export, markdown, front matter, cover, icon, templates, json, scripts]
---

`markdrop page` works with [pages](/pages/overview) from your terminal: create one from a Markdown file, print it, replace or add to its text, set its icon and cover, add images from your disk, and go back to an earlier version. `markdrop link set` changes a page's address and `markdrop export` saves it as a file.

These commands need an API token. See [Sign in with an API token](/cli/login-and-tokens).

## Name a page

Every command takes the page's slug or any of its links: `release-notes`, `https://markdrop.in/release-notes`, or its address on a workspace's own domain, such as `https://docs.acme.com/guides/release-notes`. A page whose link you changed is still found by its old one.

## Create a page

```bash
markdrop page new "Release notes"
```

```text
  ✓ Created the page "Release notes" (k3x9q2mfa1)
https://markdrop.in/k3x9q2mfa1
```

Standard output carries only the link, so `url=$(markdrop page new "Q3 plan")` works. A new page gets a cover picked for it, as in the app, unless you give it one or pass `--no-auto-cover`.

```bash
markdrop page new "Setup" --from-file setup.md --slug setup-guide
markdrop page new "Setup" --workspace Acme --folder guides --from-file setup.md
markdrop page new "Step 2" --parent setup-guide --from-file step2.md
markdrop page new "Standup" --template meeting-notes
cat draft.md | markdrop page new "Draft" --from-file - --icon 📝
```

| Flag | What it does |
|---|---|
| `--from-file` | The page's Markdown: a file, or `-` for standard input. Front matter at the top (`icon:`, `cover:` and so on) becomes the page's [properties](/pages/properties-and-views). |
| `--template` | Start from a template instead. List them with `markdrop page templates`. Can't go with `--from-file`. |
| `--workspace`, `--folder` | File it in one of your workspaces (its id, name or custom domain) and a folder there (a path like `guides/setup`, or an id). See [Workspaces and folders](/cli/workspaces). |
| `--parent` | Put it inside another page you can edit. It then lives in that page's workspace and folder and gets its access, so it can't go with `--workspace`. See [Sub-pages](/pages/sub-pages). |
| `--slug` | Its address, `markdrop.in/<slug>`: 3 to 50 letters, digits, `-` or `_`. If it is taken, nothing is created. |
| `--icon`, `--cover` | An emoji icon; a cover such as `gallery:dusk` or an `https://` image. For an image file from your disk, create the page first, then use [`page image add`](#add-images). |
| `--no-auto-cover` | Don't pick a cover for it. |

### Templates

```bash
markdrop page templates
markdrop page templates --workspace Acme
```

```text
ID              NAME                            SCOPE      DESCRIPTION
feature-guide   Feature guide / release notes   builtin    What changed, who it's for and how to use it
meeting-notes   Meeting notes                   builtin    Agenda, notes and action items
671c0e2f…       Acme spec                       workspace  -
```

You get the built-in templates and your own; with `--workspace`, that workspace's too. Pass the `ID` to `page new --template`. See [Templates](/pages/templates).

## Read a page

```bash
markdrop page get release-notes > release-notes.md
```

`page get` prints the page's Markdown, with its front matter, so what you print can go back with `page update` unchanged. `--body` leaves the front matter out. `--info` prints the page's details instead:

```text
https://markdrop.in/release-notes
  title      Release notes
  slug       release-notes
  editor     blocks
  revision   7
  updated    2026-11-04 09:12 UTC
  icon       🚀
  cover      gallery:dusk
  sub-page   Q3 (release-notes-q3)
```

## Change a page

Replace the whole text with a file's:

```bash
markdrop page get notes > notes.md
$EDITOR notes.md
markdrop page update notes --from-file notes.md
```

`--title` changes the title, with or without `--from-file`. The page as it was is kept in its [history](#versions). If someone saved the page after you read it, pass the revision you read (`page get --info` shows it) as `--base-rev`, and the update is refused instead of overwriting their change:

```bash
markdrop page update notes --from-file notes.md --base-rev 7
```

```text
Error: the page changed since revision 7 (it is at revision 8); read it again and redo the change
```

Add to the end instead of replacing:

```bash
markdrop page append standup "**Blocked:** waiting on review"
markdrop page append standup -- "- Shipped the CLI update"
git log --oneline -5 | markdrop page append changelog --from-file -
```

Markdown that starts with `-`, such as a list item, goes after `--` so it isn't read as a flag. If someone saves the page while you append, your text is added to their version. Both commands are refused while someone else has the page open in the editor; try again a minute later.

### Icon, cover and other properties

```bash
markdrop page props release-notes                       # show them
markdrop page props release-notes --icon 🚀 --cover gallery:dusk --cover-y 30
markdrop page props release-notes --cover auto          # pick one, like a new page gets
markdrop page props release-notes --full-width --font serif
markdrop page props release-notes --clear cover
```

| Flag | What it sets |
|---|---|
| `--icon` | An emoji, or `asset:<id>` of an image on the page. |
| `--cover` | `gallery:<name>` (a built-in cover), `asset:<id>`, an `https://` image, or `auto`. |
| `--cover-y` | The cover's focal point, from `0` (top) to `100` (bottom). |
| `--full-width`, `--small-text`, `--font` | Layout: full width, smaller text, and `default`, `serif` or `mono`. |
| `--locked` | Only the owner and workspace admins can edit it. |
| `--allow-export=false` | People who can only read it can't export it. Editors always can. |
| `--clear` | Remove one, such as `--clear icon`. Repeat it for more. |
| `--set` | A typed property of the page's folder, such as `--set Status=Done` or `--set Points=3`. Values that are JSON are read as JSON: `--set 'Tags=["a","b"]'`. |

These are stored as front matter at the top of the page, the same place the app keeps them. See [Properties and views](/pages/properties-and-views).

## Add images

```bash
markdrop page image add launch-notes hero.jpg --cover
markdrop page image add launch-notes chart.png --append --alt "Signups by week"
markdrop page image add launch-notes diagram.png
```

Uploads a PNG, JPEG, GIF or WebP image of up to 10 MB to the page. `--cover` makes it the cover, `--icon` the icon, and `--append` adds it at the end of the page. Without them it prints the Markdown that shows the image, `![diagram](asset:…)`, to put in the page where it belongs. Anyone who can read the page sees the image. See [Images](/pages/images).

## Versions

```bash
markdrop page versions notes
```

```text
  VERSION  SAVED                 BY          TITLE                SIZE
* 9        2026-11-04 09:12 UTC  Riya Shah   Notes                2.1 KB
  8        2026-11-04 08:40 UTC  Riya Shah   Notes                1.9 KB
  7        2026-11-03 17:02 UTC  Alex Kim    Notes (restored from 4)  1.7 KB
```

`*` marks the version that is the page now. `markdrop page version notes 8` prints that version's Markdown, and `markdrop page restore notes 8` makes it the page again. The page as it was is saved first, so a restore can be undone the same way. `--cursor` lists older versions. See [Version history](/pages/history).

`markdrop versions` and `markdrop restore`, without `page`, are for [published files](/cli/upload-and-replace).

## Change a page's link

```bash
markdrop link set https://markdrop.in/k3x9q2mfa1 q3-roadmap
```

```text
  ✓ Changed the link: q3-roadmap (the old link, /k3x9q2mfa1, redirects there)
https://markdrop.in/q3-roadmap
```

Works for pages, documents and files you own. The old link keeps working and redirects to the new one, on markdrop.in and on the workspace's domain, and embeds and mentions of it keep working. A slug another document has, or had, or that was deleted less than 30 days ago is refused. `--check` only tells you whether the slug is free.

## Export a page

```bash
markdrop export release-notes                        # ./release-notes.md
markdrop export spec --format html -o spec.html
markdrop export handbook --subpages -o ~/Backups/    # handbook.zip
markdrop export notes -o - | wc -w
```

| Flag | What it does |
|---|---|
| `--format` | `md` (portable Markdown, the default), `html` (one file with its images inside) or `zip` (the Markdown with its images). |
| `--subpages` | Add every sub-page you can open. The result is a zip with a folder per page. |
| `-o` | A file name, a folder to save into, or `-` for standard output. Default: the current folder, under the name Markdrop gives it. |
| `--force` | Overwrite a file that is already there. Without it, the command refuses. |

What an export contains, and what it leaves out, is in [Export a page](/pages/export).

## Scripting with --json

Every command here takes `--json` and then prints one JSON object on standard output and nothing else:

```bash
$ markdrop page new "Notes" --from-file notes.md --json
{"url":"https://markdrop.in/notes-4f2a","markdrop_url":"https://markdrop.in/notes-4f2a","workspace_url":null,"slug":"notes-4f2a","title":"Notes","rev":1}
```

`page get --json` adds `markdown`, `editor`, `parent`, `properties`, `children` and `assets`; `page image add --json` adds `asset` and `markdown`; `export --json` gives `path`, `filename` and `bytes`. Errors go to standard error, with exit code 1.
