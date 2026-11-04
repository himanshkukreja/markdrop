---
title: A tour of the app
description: Where your files, shared items, analytics, workspaces and settings live, and what each button on a document or file page does.
updated: 2026-11-04
prerequisites: [/get-started/accounts]
keywords: [dashboard, my files, sidebar, navigation, shortcuts, command palette, trash, top bar, hide sidebar]
---

Once you sign in, Markdrop works like a drive for things that render. This page walks through the sidebar, the **Create** menu, and the bar on top of every document and file.

::video{id="app-tour" title="A tour of the app" duration="0:56"}

## Create something

**Create** sits at the top of the app. It has four choices:

![The Create menu open in the app header, listing Markdown document, Artifact, README builder and Send a file, each with a one-line description.](/docs-assets/get-started/tour/create-menu.webp)

| Choice | What it does |
| --- | --- |
| **Markdown document** | Write or paste Markdown and publish a link. Opens [markdrop.in/new](https://markdrop.in/new). |
| **Artifact** | Upload an HTML page, PDF, spreadsheet, Word document or video. Opens [markdrop.in/upload](https://markdrop.in/upload). |
| **README builder** | Assemble a README from ready-made sections. See [README builder](/documents/readme-builder). |
| **Send a file** | Send files peer to peer; they aren't stored on Markdrop's servers. See [Send files peer to peer](/share/send-files). |

## The sidebar

| Item | What's there |
| --- | --- |
| **My files** | Everything you own. Filter by **All**, **Documents** or **Artifacts**, and search by title or link. |
| **Shared with me** | Documents and files people added you to by email, and **Access requests** waiting for your answer. A row's menu has **Remove me** to take yourself off. |
| **Recent** | What you opened lately, signed in. |
| **Analytics** | Views and engagement across everything you own. See [Analytics](/analytics/overview). |
| **Trash** | What you deleted in the last 30 days, to restore or delete forever. See [Trash and restoring](/documents/trash). |
| **Workspaces** | Each workspace you belong to, with its folders, pages, documents and files. Pages show their emoji, and what you have open is highlighted and scrolled into view. Point at a row for **+** (add a page inside) and **⋯**. Drop files onto a folder to upload them there. **New workspace** creates one. |
| **VS Code** | Your [API tokens](/account/api-tokens), which the VS Code extension and the CLI use. |
| **Connected apps** | AI assistants and other apps you've allowed in. See [Connected apps](/account/connected-apps). |
| **Settings** | Your display name, theme and the weekly analytics email. |

![The app sidebar with My files, Shared with me (2 new), Recent, Analytics, the Workspaces section showing Acme with its Guides, Releases and Sales folders, then VS Code (3 tokens), Connected apps and Settings.](/docs-assets/get-started/tour/sidebar.webp)

Each row in **My files** has a **Copy link** button and a menu with **Open**, **Edit** (documents only), **Analytics**, **Share…**, **Change URL** and **Delete**, plus **Move to folder…** or **Add to a workspace…** where they apply. On a phone, **Copy link** is in the menu instead.

![My files with the All, Documents and Artifacts filters, and rows showing each title, its folder, its link, views, who can open it and Copy link.](/docs-assets/get-started/tour/my-files.webp)

## On a document

A document opens full screen, with nothing but the text. Press :kbd[Esc] or choose **Show details** in the corner to bring back its bar. It's one bar at the top, the same as a [page](/pages/overview#the-top-bar)'s, and it stays in place as you scroll. On the left are the sidebar button, the logo (your workspace's logo on its own domain) and the title, after the workspace and folder if you're a member. On the right:

- [Who's viewing](/sharing/see-whos-viewing), when someone else has it open too.
- **Edit**: shown to the owner, to people who can edit it, and to whoever holds the edit secret in this tab. Everyone else finds **Edit** in **More actions**, where it asks for the edit secret.
- **Read full screen**: hides everything but the text again. Press :kbd[F]; press :kbd[Esc] to come back.
- **Share**: shown to the owner, and to people allowed to share it on. See [Share with specific people](/sharing/share-with-people). Everyone else gets **Copy link** here instead: it copies the address, and for an encrypted document it includes the key.
- **More actions** (**⋯**): **Copy link** (when **Share** is in the bar), **View raw**, **Export PDF**, **Save a copy** (on other people's documents), **Request edit access** (if you're signed in and can't edit it), **Report**, **Details** and, on your own documents once you've connected Google, **Publish to Google Docs**. If someone added you by email, it also has **Remove me**.
- **Create** and your account menu, or **Sign in**. If you're signed out, the theme is in **More actions**.

![The bar above a document with Copy link, Edit, Share and Read full screen, and More actions open showing View raw and Export PDF, with the Details and Access panels on the right.](/docs-assets/get-started/tour/document-bar.webp)

**Details** lists when it was published, its views, its reading time and when it expires. The owner, and people allowed to share it, also see an **Access** card with who can open it and a **Share** button. On a wide screen it sits beside the text, with **Contents** built from the headings on the other side. To hide both and keep just the text, choose the sidebar button or press **⌘ \\** (**Ctrl \\** on Windows and Linux); your browser remembers it, and **Contents** moves into the bar. On smaller screens **Contents** is in the bar, and on a phone **Contents**, **Copy link** and **Share** or **Edit** are in a bar at the bottom of the screen.

## On a page

A [page](/pages/overview) has the same bar, with breadcrumbs for the pages above it and **Saved** beside **Share**, and its sidebar holds the page tree. Press **⌘ \\** (**Ctrl \\** on Windows and Linux) to hide the sidebar, and point at the left edge of the window to peek at it. See [The top bar](/pages/overview#the-top-bar).

## On a file

A file also opens full screen. Press :kbd[Esc] or choose **Show details** to see it with the same one bar at the top as a document: the logo, the title with the file's type, then [who's viewing](/sharing/see-whos-viewing), **Download**, **Read full screen**, **Share** (or **Copy link** if you can't share it), **More artifact actions** (**⋯**), **Create** and your account menu (or **Sign in**). The menu starts with the file's size, views and date, then has **Copy link** (when **Share** is in the bar), and for the owner **Settings** (the title, link, password, expiry, the file and its versions) and **Delete artifact**. Someone allowed to edit sees **Replace file**, and readers see **Report**. On a phone, **Share** is first in the menu, and **Copy link** and **Download** are in a bar at the bottom of the screen.

## Search and shortcuts

Press :kbd[⌘K] (:kbd[Ctrl K] on Windows and Linux) anywhere in the app to [search](/workspaces/search) everything you can open, typos and all, or ask AI a question about your documents.

Two single-key shortcuts work when you aren't typing in a box: :kbd[F] reads a document full screen, and :kbd[/] jumps to the search box in **My files**. They're on by default. To turn them off, open **Settings › Account** and switch off **Keyboard shortcuts**. The setting applies to this browser.

## Related

- [Do you need an account?](/get-started/accounts)
- [Who can open what](/sharing/who-can-open)
