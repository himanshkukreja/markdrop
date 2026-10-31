---
title: Docs Studio FAQ and troubleshooting
nav: FAQ and troubleshooting
description: Answers about Docs Studio, and what to do when a publish or import fails, a site isn't public yet, or you can't edit or see a site.
updated: 2026-10-31
keywords: [faq, troubleshooting, publish failed, build failed, import failed, not public, can't edit, read only, no access, docs studio help]
---

## About Docs Studio

:::details[What's the difference between Docs Studio and docs.markdrop.in?]
Docs Studio, at [markdrop.in/docs-studio](https://markdrop.in/docs-studio), is where you build docs sites for your own product. docs.markdrop.in is Markdrop's documentation, the site you're reading. The pages in this site's Docs Studio tab explain the product; everything else here is about Markdrop's documents, files, sharing and workspaces.
:::

:::details[What does it cost?]
Docs Studio is free while it's in beta. During the beta there are limits on how many sites a workspace can have and how much each site can do; when you reach one, the app tells you.
:::

:::details[Do my readers need an account?]
No. Every published site is public and opens in any browser. Password-protected and members-only sites are [coming soon](/docs-studio/site-settings#who-can-read-it).
:::

:::details[Can I keep my site out of search engines?]
Yes. Turn off **Let search engines index the site** in [Settings](/docs-studio/site-settings#who-can-read-it) and publish. The site stays public for anyone with the link, but asks search engines not to index it.
:::

:::details[Can readers ask questions about my docs?]
Yes, with [Ask AI](/docs-studio/ask-ai). Turn it on in Settings and publish: readers get answers from your published pages, with links to the sections they came from. Each site has a monthly number of answers during the beta.
:::

:::details[Can I use my own domain?]
Not yet: it's [coming soon](/docs-studio/site-settings#your-own-domain). Every site is served at its free `<address>.docs.markdrop.in` address.
:::

:::details[Can I keep my docs in Git?]
[GitHub sync](/docs-studio/github-sync) is coming soon. Until then the editor's Markdown mode shows each page as a file, and the engine can be [self-hosted](/docs-studio/self-hosting) from a folder.
:::

:::details[Can I get my content out?]
Every published page is available as Markdown at its address plus `.md`, and the whole site is in `/llms-full.txt`. In the editor, Markdown mode shows each page's source.
:::

## Troubleshooting

### My site isn't public yet

- **It hasn't been published.** New sites are drafts: the home page card says **Draft** and the Publishes tab says **Nothing is public until the first publish**. [Publish](/docs-studio/publishing) it.
- **The publish is still running or failed.** Check its row on the **Publishes** tab.
- **It's waiting for a review.** The card says **In review**. A reviewer or admin has to [approve it](/docs-studio/reviews#approve-or-request-changes).
- **It was unpublished.** The card says **Unpublished**. Publish again to put it back.
- **You changed the address.** The new address goes live with the next publish, and the old one stops working.

### My changes aren't on the site

Saved drafts aren't public until you publish. The page tree marks pages with unpublished changes with a dot, and the Publishes tab lists every change since the last publish. Theme, Ask AI, redirect and sidebar changes also need a publish.

### A publish failed

The publish is marked **Failed** with the reason, and readers keep the last live version. Common causes:

- **"Add a page before publishing."** The site has no pages.
- **The day's publishes are used up.** Try again tomorrow (UTC), or [restore](/docs-studio/publishing#restore-an-earlier-publish) an earlier publish, which doesn't count.
- **"Password and members-only sites are coming soon."** Set **Who can read it** back to **Anyone** in Settings.
- **"This site is too large to publish in one snapshot."** Split very long pages.

If it fails again with the same reason, contact Markdrop using the address in the [privacy policy](https://markdrop.in/privacy), with the site's address.

### An import failed

The import screen says **The import stopped** with the reason. Check that the address is the site's public address (`https://…`), that it opens in a private browser window, and that it's a GitBook site. Then choose **Start again**. A private GitBook space can't be imported.

### Some imported pages need fixing

That's what the report is for: [check the report](/docs-studio/import-from-gitbook#check-the-report) before you publish. Its rows link to each page.

### The page is Read only

Someone else has it open: the banner and the page tree show who. It opens for editing when they're done, or two minutes after they close their browser. A Docs Studio admin can **Take over**. If the bar says **View only**, your role is Viewer: ask an admin for the Editor role.

### I can't see a workspace's sites

Your Docs Studio role there is **No access**, or a site gives you **No access**. Workspace membership alone doesn't give access: a Docs Studio admin of the workspace has to [give you a role](/docs-studio/members-and-roles#give-someone-a-role).

### I can't create a site

In a workspace, only Docs Studio admins create sites. The workspace may also have its most sites for the beta: delete one to make room, or create a personal site.

### The design didn't change on the site

**Save design**, then publish. Custom CSS that has a problem can't be saved: the box says what's wrong. See [Custom CSS](/docs-studio/brand-and-style#custom-css).
