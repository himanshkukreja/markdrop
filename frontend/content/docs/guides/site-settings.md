---
title: Guide settings
description: A guide's settings. Its address, Ask AI, who can read it, search indexing, reviews, people, redirects, and unpublishing or deleting it.
updated: 2026-10-31
prerequisites: [/guides/create-a-site]
keywords: [settings, address, slug, custom domain, own domain, cname, dns, ssl certificate, ask ai, password, members only, search engines, noindex, unpublish, delete guide, delete site]
---

Open a guide and choose **Settings**. Only Guides admins can change them; everyone else sees how the guide is set up. Each setting saves as soon as you change it, and reaches readers at the next [publish](/guides/publishing).

## Address

The guide's free address, `<address>.guides.markdrop.in`, with **Copy link**. It always works, even after you add your own domain.

To change it, choose **Change**, type the new address and choose **Save address**. The same [rules](/guides/create-a-site#the-address) apply as when you created the guide. The new address goes live at the next publish, and the **old one stops working**, so change it before you share the link.

![The Address card with acme.guides.markdrop.in and Copy link.](/docs-assets/guides/site-settings/settings-address.webp)

## Your own domain

Serve the guide from a subdomain your company owns, like `help.acme.com` or `docs.acme.com`. You add one DNS record; the HTTPS certificate is issued and renewed for you. The free address keeps working beside it. Only Guides admins add and remove domains, and a guide can have two.

This is separate from a Markdrop workspace's [own domain](/workspaces/custom-domain), which serves the workspace's documents and files, not its guides.

:::note
If the card says **Not available yet**, own domains aren't switched on for your Markdrop server. The free address always works.
:::

### Use your own domain

1. In the guide's **Settings**, under **Your own domain**, choose **Add a domain**, type the subdomain (for example `help.acme.com`) and choose **Add domain**.
2. The card shows the record to add, with copy buttons:

   | Type | Name | Value |
   |---|---|---|
   | `CNAME` | `help.acme.com` | `cname.guides.markdrop.in` |

3. Sign in where your domain's DNS is managed (often where you bought it) and add that `CNAME` record. Many providers add your domain to the name for you: there, type just `help`.
4. Wait. Markdrop checks on its own and the status moves from **Checking DNS** to **Issuing certificate** to **Live**, usually a few minutes after your DNS change is visible. Choose **Re-check** to check right away.
5. Once it's **Live**, readers get the guide at `https://help.acme.com`. Markdrop publishes the live version again, so links, the sitemap, `llms.txt` and preview cards use your domain from then on. Keep the record in place.

### Where to add the record

::::tabs{sync="dns"}
:::tab[Cloudflare]
**DNS** › **Records** › **Add record**. Type **CNAME**, Name `help`, Target `cname.guides.markdrop.in`, and set **Proxy status** to **DNS only** (the grey cloud). Save.
:::
:::tab[GoDaddy]
**My Products** › your domain › **DNS** › **Add New Record**. Type **CNAME**, Name `help`, Value `cname.guides.markdrop.in`, TTL **1 Hour**. Save.
:::
:::tab[Namecheap]
**Domain List** › **Manage** › **Advanced DNS** › **Add New Record**. Type **CNAME Record**, Host `help`, Value `cname.guides.markdrop.in`, TTL **Automatic**. Save with the check mark.
:::
:::tab[Other providers]
Add a record of type **CNAME** whose name (or host) is your subdomain and whose value (or target, or "points to") is `cname.guides.markdrop.in`. If the form shows your domain after the name field, type only the subdomain part.
:::
::::

Two more records, **Ownership record** and **Certificate record** (both `TXT`), may show under the CNAME. You only need them when your domain sits behind another proxy or CDN, or if you want it checked before you switch the CNAME over from another service.

### Root domains

A root domain like `acme.com` can't be added yet: DNS doesn't allow a `CNAME` record at the root, and Markdrop doesn't offer fixed IP addresses for an `A` record. Use a subdomain such as `help.acme.com` or `docs.acme.com`, and if you want, redirect the root to it at your DNS provider.

### Remove a domain

Choose **Remove** next to it and confirm. The guide stops answering there right away; links, the sitemap and search results go back to the free address after the publish Markdrop starts for you. You can then delete the `CNAME` record.

### When a domain doesn't go live

- **It stays on Checking DNS.** The `CNAME` record isn't visible yet. Check its name and value for typos, and that the name doesn't end up doubled (`help.acme.com.acme.com`) because your provider added the domain for you. DNS changes can take up to an hour, sometimes longer. Then choose **Re-check**.
- **There's already a record for that name.** A subdomain can have only one `CNAME`, and no `CNAME` beside other records of the same name. Delete the old record first.
- **It's on Cloudflare with the orange cloud.** Set the record to **DNS only**, or add the **Ownership record** and **Certificate record** too.
- **It stays on Issuing certificate.** A `CAA` record on your domain may allow only other certificate authorities. Remove it, or add one that allows `letsencrypt.org` and `pki.goog`.
- **It says Problem.** Markdrop checks for 3 days, then stops and shows what was in the way. Fix the record, then choose **Re-check** to start again.
- **"Another guide already uses that domain."** A domain can serve one guide. Remove it from the other guide first.

## Ask AI

Turn the assistant on or off, name it, and suggest questions. See [Ask AI on your guide](/guides/ask-ai).

## API reference

The OpenAPI file your guide's API reference is generated from: upload it or fetch it from a URL, see what it found, preview the sidebar it makes, and choose where it appears and whether readers get Try it. See [API reference from an OpenAPI file](/guides/api-reference).

## Who can read it

:::note[Coming soon]
For now every published guide is public: **Anyone** can read it. **Anyone with the password** (for a beta or a partner preview) and **Workspace members only** (readers sign in with Markdrop) are listed but aren't available yet; choosing one says so and keeps the guide public.
:::

**Let search engines index the guide** is on by default. Turn it off to keep the guide out of search results, for example while it's a work in progress: after the next publish, every page asks search engines not to index it (a `noindex` tag and header), `robots.txt` disallows crawling, and the sitemap is empty. Readers with the link can still open the site.

## Reviews

Require changes to be approved before they're published. See [Reviews](/guides/reviews).

## People

Give someone a different role on this guide. See [Members and roles](/guides/members-and-roles#a-different-role-on-one-guide). If you aren't an admin, this card shows **Your role**.

## GitHub sync

Marked **Coming soon**. See [GitHub sync](/guides/github-sync).

## Imported from GitBook

For an imported guide: where it came from, and **Open the import report**. See [Import from GitBook](/guides/import-from-gitbook#check-the-report). Other guides show **Started from** (a template, or blank) here.

## Redirects

Send old addresses to their new pages. See [Redirects](/guides/pages-and-navigation#redirects).

## Unpublish or delete

**Take the guide down** has two buttons:

- **Unpublish** takes the guide offline: its address stops showing it. Your pages, drafts and publish history stay, and publishing again puts it back.
- **Delete guide** removes every page, version and publish, and the address stops working. To confirm, you type the guide's name. This can't be undone, and its address is free for someone else to use.

![The Take the guide down card with Unpublish and Delete guide, and the note "Unpublish keeps your pages and history; delete removes everything."](/docs-assets/guides/site-settings/settings-danger.webp)

Deleting a guide also makes room for a new one in the workspace.
