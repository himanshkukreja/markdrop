---
title: Put your workspace on your own domain
description: Serve a workspace's documents and folders from an address you own, like docs.acme.com. Two DNS records, then one check.
updated: 2026-10-30
prerequisites: [/workspaces/create, /workspaces/members-and-roles]
keywords: [domain, custom domain, dns, cname, txt, a record, apex, cloudflare, godaddy, namecheap, route 53, verify, ssl, certificate]
---

Serve every document and folder in a workspace from an address you own, like `docs.acme.com`. A document filed under **Guides** opens at `docs.acme.com/guides/<document>`. Existing markdrop.in links keep working.

:::note[Before you start]
You need to be an **Admin** or the **Owner** of the workspace, and able to add DNS records for the domain (or know who can). A workspace can have up to 25 domains.
:::

## Add your domain

::::steps
### Add the domain
Open the workspace's settings and go to the **Look and domain** tab. Under **Your own domain**, choose **Add a domain** (**Add another domain** if the workspace already has one). Type the hostname, like `docs.acme.com`, leave **What it serves** on **Documents and files**, and choose **Add domain**.

### Prove it's yours
Markdrop shows two records. The first is the **Ownership record**, a TXT record. Add it where you manage DNS for `acme.com`.

![The help.acme.com domain card awaiting DNS: the steps Added, DNS records, Verified and Live, "Your DNS is at Cloudflare" with Open Cloudflare DNS, the Ownership record (TXT) and the Routing record (CNAME to edge.markdrop.in), each Name and Value with a copy button, and Check DNS.](/docs-assets/workspaces/custom-domain/dns-records.webp)

### Point it at Markdrop
The second is the **Routing record**. A subdomain like `docs.acme.com` uses a CNAME. An apex domain like `acme.com` uses an A record instead, because DNS doesn't allow a CNAME there.

### Check DNS
Choose **Check DNS**. When both records are found, the domain is verified and goes live on its own. The status changes to **Live**, and readers can open it.
::::

For `docs.acme.com`, the records look like this. Copy the exact values Markdrop shows you; the TXT value is unique to your domain.

| Type | Name | Value |
| --- | --- | --- |
| TXT | `_markdrop-verify.docs` | `markdrop-verify=…` (your value) |
| CNAME | `docs` | `edge.markdrop.in` |

For an apex domain, `acme.com`:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `_markdrop-verify` | `markdrop-verify=…` (your value) |
| A | `@` | `76.76.21.21` |

::clip{src="/docs-assets/workspaces/custom-domain/custom-domain-routing" alt="Animation: a TXT record proves acme.com is yours, a CNAME points docs at edge.markdrop.in, Check DNS finds both, the status goes from Awaiting DNS to Live, and a reader's request to docs.acme.com reaches the workspace's documents." theme="light"}

Markdrop works out which panel your DNS lives in from your nameservers. When it knows, it says so ("Your DNS is at Cloudflare"), offers a button to open that provider's DNS page, and writes each name the way that provider expects it.

::::tabs{sync="dns"}
:::tab[Cloudflare]
Add both records in your domain's DNS settings. In **Name**, type only the part before your domain: `docs`, not `docs.acme.com`.

Set **Proxy status** to **DNS only** (grey cloud) for the CNAME. An orange cloud breaks certificate issuance.
:::
:::tab[GoDaddy]
GoDaddy adds your domain to the name for you. In **Name**, type only the sub-part: `_markdrop-verify.docs` and `docs`. For an apex domain, use `@` for the A record.
:::
:::tab[Namecheap]
Use the **Advanced DNS** tab, not **Domain › Redirect**. In **Host**, type only the sub-part: `_markdrop-verify.docs` and `docs`.
:::
:::tab[Route 53]
Open the hosted zone for your domain and create each record. In **Record name**, type only the sub-part: `_markdrop-verify.docs` and `docs`.
:::
:::tab[Other]
Any DNS provider works. Most panels add your domain to the name for you, so type only the part before it. If yours wants the full hostname, use the names exactly as Markdrop shows them, like `_markdrop-verify.docs.acme.com`.

If your provider offers an ALIAS or ANAME record at the apex, you can point it at `edge.markdrop.in` instead of using the A record.
:::
::::

:::tip[Someone else runs your DNS?]
Under the records, choose **Send to your DNS admin**. You get a ready-to-send message with both records, what they do and what they don't touch. You can copy it, open it in your email, or choose **Download CSV**.
:::

## Use the API

Prefer the terminal? The same steps work through the API with an [API token](/account/api-tokens). Your workspace id is in the address of its settings page, `markdrop.in/settings/workspaces/<workspace-id>`. `kind` is `app` for **Documents and files**, or `cdn` for **Files only**.

::::tabs{sync="lang"}
:::tab[curl]
```bash title="Add docs.acme.com"
curl -X POST "https://api.markdrop.in/api/v1/workspaces/$WORKSPACE_ID/domains" \
  -H "Authorization: Bearer $MARKDROP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"host": "docs.acme.com", "kind": "app"}'
```
:::
:::tab[JavaScript]
```js title="Add docs.acme.com"
const res = await fetch(
  `https://api.markdrop.in/api/v1/workspaces/${process.env.WORKSPACE_ID}/domains`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MARKDROP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ host: "docs.acme.com", kind: "app" }),
  },
);
const domain = await res.json();
```
:::
:::tab[Python]
```python title="Add docs.acme.com"
import os, requests

res = requests.post(
    f"https://api.markdrop.in/api/v1/workspaces/{os.environ['WORKSPACE_ID']}/domains",
    headers={"Authorization": f"Bearer {os.environ['MARKDROP_TOKEN']}"},
    json={"host": "docs.acme.com", "kind": "app"},
)
domain = res.json()
```
:::
::::

The response includes the records to add: `dns_record_name` and `dns_record_value` for the TXT record, and `dns_target_type`, `dns_target_name` and `dns_target_value` for the routing record. After you add them, check DNS with `POST /api/v1/workspaces/<workspace-id>/domains/<domain-id>/verify`.

## Watch it once

::video{id="custom-domain" title="Put a workspace on docs.acme.com" duration="1:30"}

## It can take a while

:::warning
DNS changes can take up to an hour to show up, sometimes longer. If **Check DNS** says a record isn't visible yet, wait and check again. Each record shows **Found** or **Not found yet**, so you know which one to look at.
:::

![After Check DNS on help.acme.com: the Ownership record (TXT) shows Not found yet and the Routing record (CNAME) shows Found.](/docs-assets/workspaces/custom-domain/dns-check-partial.webp)

Markdrop doesn't check a new domain on its own: choose **Check DNS** when you've added the records. A domain that's never verified is dropped after 7 days, and you can add it again.

## Make it the default

The first domain you verify becomes the workspace's address on its own. With more than one, open a domain's menu and choose **Make default**. The default is the address Markdrop uses for shared links and preview cards. Every live domain keeps serving.

## Files only domains

When you add a domain, **What it serves** has a second option, **Files only**: a plain file host for raw bytes, with no document pages. Use it for something like `files.acme.com`.

A Files only domain serves files your members upload, and anything it serves can set cookies on its parent domain. Prefer a domain you use for nothing else, not one that also hosts your app or marketing site.

## Keep it live

Keep both records in place after the domain is live. Markdrop checks them again every day.

If the records stop resolving to Markdrop for three days, the domain stops serving and shows **Lapsed**. Put both records back, then choose **Check DNS again**. Links on markdrop.in keep working throughout.

To see the records again later, open the domain's menu and choose **Show DNS records**. **Download records (CSV)** is in the same menu.

## Take a domain off the air

Open the domain's menu:

- **Detach** stops serving at once, and links to the domain fail. The domain stays verified, so you can bring it back later without touching DNS.
- **Remove domain** stops serving and also discards the verification. Adding it back means adding the DNS records and waiting for them again.

Documents keep working on markdrop.in either way.

## If it doesn't verify

:::details[It says the TXT record wasn't found]
Most DNS panels add your domain to the name for you. If you typed `_markdrop-verify.docs.acme.com`, the record may have ended up at `_markdrop-verify.docs.acme.com.acme.com`. Change the name to `_markdrop-verify.docs`, then check again.
:::

:::details[It found a TXT record, but says none matched]
The value must match exactly, starting with `markdrop-verify=`. Copy it again with the copy button next to **Value**, and check that your panel didn't add quotes or spaces.
:::

:::details[The domain is verified but not live yet]
The routing record isn't visible yet. The domain goes live as soon as it is. Check that the CNAME points at `edge.markdrop.in` (or the A record at `76.76.21.21` for an apex domain), and that no other record for the same name points somewhere else.
:::

:::details[Cloudflare shows the domain, but pages don't load]
Turn the proxy off for the CNAME: set **Proxy status** to **DNS only** (grey cloud).
:::

:::details[It says the domain is already claimed]
Another workspace has verified it. A domain can belong to one workspace at a time. If it's yours, remove it from the other workspace first.
:::

:::details[Will my markdrop.in links break?]
No. They keep working. Your domain is an extra address for the same documents.
:::
