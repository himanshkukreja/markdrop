---
title: Import a guide from GitBook
nav: Import from GitBook
description: Copy a public GitBook site into Markdrop Guides with its pages, images, navigation and old links, then check the report before you publish.
updated: 2026-10-31
prerequisites: [/guides/create-a-site]
keywords: [gitbook, import, migrate, move from gitbook, migration, redirects, alt text, broken links, needs a look]
---

Paste the address of your GitBook site and Markdrop Guides copies it into a new guide: every page, including hidden ones, the sidebar's groups and order, images and files, page icons, your logo and accent colour, and the old addresses. Your GitBook site isn't changed.

## Import a guide

::::steps
### Start a new guide
Choose **New guide**, pick where it lives, and under **How do you want to start?** choose **Import from GitBook**.

### Paste the address
Under **Your GitBook site**, paste the **Public address** readers use, like `https://docs.acme.com`. Markdrop Guides suggests an address from it.

### Name it
Type the **Guide name**, check the **Address**, and choose **Import**.

### Wait for the steps
The import screen shows four steps: reading the navigation and page list, copying pages and converting blocks, copying images and files, and saving the pages as drafts. A large site takes a few minutes. You can close the page: the import keeps running, and the screen shows where it is when you come back.
::::

![The New guide form with Import from GitBook selected and https://northwind.gitbook.io/docs as the public address.](/docs-assets/guides/import/import-form.webp)

:::warning[Private GitBook spaces]
Markdrop Guides can only read a site anyone can open. A private GitBook space can't be imported this way.
:::

## Watch it once

::video{id="guides-import-video" title="Import a GitBook site into Markdrop Guides" duration="0:45"}

## Check the report

When the import is done, the screen says **Your pages are here** and lists what **Needs a look before you publish**. Each row opens its list, and each entry links to the page in the editor.

| Row | What it means | What to do |
| --- | --- | --- |
| **Images or files we couldn't copy** | They were missing or unreachable on the old site. | Upload them again in the editor, or remove them. |
| **Links that were already broken** | Links that didn't work on the GitBook site either. | Fix or remove them. |
| **Image descriptions we wrote for you** | GitBook had no alt text, so the importer used the file names. | Write a real description: screen readers and search use it. |
| **Pages hidden from the sidebar in GitBook** | Imported and reachable by link, but not in the sidebar. | Keep them hidden or show them. See [Hidden pages](/guides/pages-and-navigation#hidden-pages). |
| **Page icons we couldn't match** | Brand logos and single letters with no matching icon. | Pick an icon in the page settings or leave it blank. |
| **Blocks converted approximately** | GitBook blocks with no exact match. | Check that they read right. |

![The finished import of Acme Developers: four completed steps (4 groups, 11 pages; 9 images, 1 file; 14 old links kept working) and Needs a look before you publish, with Links that were already broken open, listing two links and their pages.](/docs-assets/guides/import/import-report.webp)

Rows with nothing in them aren't shown. To open the report again later, go to the guide's **Settings** and choose **Open the import report** under **Imported from GitBook**.

## What comes across

- **Pages** become drafts, each with a first version marked **Imported** in its [history](/guides/history). Nothing is published.
- **Sidebar groups** and their order. GitBook's hidden pages stay hidden.
- **Blocks:** hints become callouts, and tabs, steps, cards and code blocks keep their shape.
- **Images and files** are copied into the guide and count towards its storage.
- **Brand:** the logo and accent colour, matched with a theme. Change it in [Design](/guides/brand-and-style).
- **Old addresses:** a GitBook address that changes gets a redirect to its new page, so links people saved keep working. The report's last step says how many.

:::note
The redirects from an import aren't listed in **Settings › Redirects**. Readers get them as soon as you publish, together with any redirects you add in Settings. If both have the same old address, the one in Settings wins.
:::

## If the import fails

The screen says **The import stopped** and shows the reason. Nothing was published and your GitBook site wasn't changed. Choose **Start again** to try a new import. See [Troubleshooting](/guides/faq#an-import-failed).
