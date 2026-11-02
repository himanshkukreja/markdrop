---
title: Put your guide on your own domain
nav: Your own domain
description: "Serve a guide from a subdomain you own, like help.acme.com: one CNAME record or one-click DNS, and the HTTPS certificate handled for you. Free."
updated: 2026-11-02
prerequisites: [/guides/publishing]
keywords: [custom domain, own domain, cname, dns, ssl certificate, https, domain connect, one-click dns, cloudflare, godaddy, namecheap, subdomain, help center domain, docs domain, caa]
---

Serve a guide from a subdomain your company owns, like `help.acme.com` or `docs.acme.com`. You add one DNS record, or approve it in one click with a supported DNS provider; the HTTPS certificate is issued and renewed for you. It's free on every guide, and the free `<address>.guides.markdrop.in` address keeps working beside it.

Only Guides admins add and remove domains, and a guide can have two. Everyone else sees them in **Settings › Domains**.

**Domains** lists every address the guide answers at, each with its status, **Copy**, **Open** (in a new tab) and a menu with its setup steps, **Check now** and **Remove domain**.

![Settings › Domains, Address and domains: learn.acme.com (Your domain, the main address for links and search) and acme.guides.markdrop.in (Free address, always works), both Live with Copy and Open, and Add another.](/docs-assets/guides/site-settings/settings-domains.webp)

This is separate from a Markdrop workspace's [own domain](/workspaces/custom-domain), which serves the workspace's documents and files, not its guides.

:::note
If the card says **Not available yet**, own domains aren't switched on for your Markdrop server. The free address always works.
:::

## Add a domain

Setup takes three steps: **Your domain**, **Connect DNS**, **Live with HTTPS**.

::::steps
### Type the subdomain
In the guide's **Settings › Domains**, choose **Add a domain**, type the subdomain (for example `help.acme.com`) and choose **Continue**.

![The three steps Your domain, Connect DNS and Live with HTTPS, and the Your domain card with learn.acme.com typed in Domain and Continue.](/docs-assets/guides/site-settings/domain-add.webp)

### Connect DNS
Markdrop looks up who runs the domain's DNS from its nameservers and says so, like "acme.com's DNS is at Cloudflare", with **Open Cloudflare DNS**. The record is written the way that provider's form asks for it, with copy buttons:

| Type | Name | Value |
|---|---|---|
| `CNAME` | `help` | `cname.guides.markdrop.in` |

Where the provider supports it, **Connect with** your provider (**Connect with Cloudflare**, say) adds the record in one click: sign in there and approve it. Markdrop asks for that one record and nothing else.

Otherwise, sign in where your domain's DNS is managed (often where you bought it) and add the `CNAME` record yourself (see [Where to add the record](#where-to-add-the-record)). **Download as CSV** gives you the record as a file.

![Connect DNS for learn.acme.com, Waiting for DNS: "acme.com's DNS is at Cloudflare" with Open Cloudflare DNS, then Add this DNS record, written the way Cloudflare's form asks for it: Name learn, Target cname.guides.markdrop.in, Proxy status DNS only (grey cloud), Not found yet, and Download as CSV.](/docs-assets/guides/site-settings/domain-setup.webp)

### Wait for it to go live
**Status** shows **Record found**, **HTTPS certificate issued** and **Live**, and checks again every minute while the page is open, usually a few minutes after your DNS change is visible. Choose **Check now** to check right away. You can leave the page: Markdrop keeps checking, and emails you when the domain is live (or if it gives up).
::::

Once it's **Live**, readers get the guide at `https://help.acme.com`. Markdrop publishes the live version again, so links, the sitemap, `llms.txt` and preview cards use your domain from then on. Keep the record in place.

## Someone else runs your DNS

Under **Someone else runs your DNS?**, send the person who does a message with the record, where to add it, and a link to check it worked: **Copy message**, **Send by email** (opens your mail app), or **Copy a link to these steps**. The link opens a public page, `markdrop.in/d/check/help.acme.com`, that shows the record to add and how far along the domain is, and checks again on its own. It says nothing about your guide.

![Someone else runs your DNS?: a message asking to add the CNAME for learn.acme.com at Cloudflare, with a link to check it worked, and Copy message, Send by email and Copy a link to these steps; below, Status: Record found (waiting for it to appear), HTTPS certificate issued and Live at learn.acme.com, checking every minute, with Check now.](/docs-assets/guides/site-settings/domain-handoff.webp)

## Where to add the record

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

## Root domains

A root domain like `acme.com` can't be added yet: DNS doesn't allow a `CNAME` record at the root, and Markdrop doesn't offer fixed IP addresses for an `A` record. Use a subdomain such as `help.acme.com` or `docs.acme.com`, and if you want, redirect the root to it at your DNS provider.

## Remove a domain

In its menu, choose **Remove domain** and confirm. The guide stops answering there right away; links, the sitemap and search results go back to the free address after the publish Markdrop starts for you. You can then delete the `CNAME` record.

## When a domain doesn't go live

- **It stays on Record found: waiting.** The `CNAME` record isn't visible yet. If the status says the name points somewhere else, an old record is still in place. Check its name and value for typos, and that the name doesn't end up doubled (`help.acme.com.acme.com`) because your provider added the domain for you. DNS changes can take up to an hour, sometimes longer. Then choose **Check now**.
- **There's already a record for that name.** A subdomain can have only one `CNAME`, and no `CNAME` beside other records of the same name. Delete the old record first.
- **It's on Cloudflare with the orange cloud.** Set the record to **DNS only**, or add the **Ownership record** and **Certificate record** too.
- **It stays on HTTPS certificate.** A `CAA` record on your domain may allow only other certificate authorities. Remove it, or add one that allows `letsencrypt.org` and `pki.goog`.
- **It says Problem.** Markdrop checks for 3 days, then stops, shows what was in the way and emails whoever added the domain. Fix the record, then choose **Check now** to start again.
- **"Another guide already uses that domain."** A domain can serve one guide. Remove it from the other guide first.

## Related

- [Guide settings](/guides/site-settings): the free address, who can read the guide, and its other settings.
- [Private pages and sections](/guides/private-pages): pages for some readers only, on every address the guide has.
- [What readers get](/guides/what-readers-get): what every address serves, for people and AI tools.
