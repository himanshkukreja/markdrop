---
title: Images in pages
description: Paste, drop or upload images into a page. They're stored with the page and shown only to people who can read it.
updated: 2026-11-04
prerequisites: [/pages/overview]
keywords: [image, images, screenshot, paste, upload, drop, alt text, caption, cover, icon, asset, mcp, ai, create_page_image_upload, copy_page_asset, curl]
---

## Add an image

- **Paste** a screenshot or a copied image while editing. Images in text you paste from Google Docs, Notion or a web page are copied into the page too. See [Paste into a page](/pages/paste).
- **Drop** an image file onto the page.
- Type `/image` and choose **Upload an image**, or paste an image link.

Images can be PNG, JPG, WebP or GIF, up to 10 MB each. They count toward your [storage](/account/limits), like files you publish.

Hover an image to align it left, centre or right, view it full screen, download it, **Replace** it, add **Alt text** (what the image shows, for people who can't see it) or delete it. Drag the handles on its sides to resize it, and type a caption under it. Readers can click an image to see it full screen.

## Who can see a page's images

An image you add to a page belongs to the page: anyone who can read the page sees it, and nobody else. It has no address of its own to share. When a page is open to **Anyone with the link**, its images load from a public address; otherwise each reader gets a short-lived address of their own, which the page renews while it's open.

If you change who can read the page, its images follow.

An image stays while the page or any of its [earlier versions](/pages/history) shows it. One that nothing shows any more is deleted 30 days later.

A page's [icon and cover](/pages/overview) can be images too. They work the same way.

## In the Markdown

An uploaded image is written as `![Alt text](asset:<id>)`, with its caption in quotes and its size and alignment after it: `![Alt text](asset:<id> "Caption"){width="60%" align="left"}`. The `asset:` address only works inside its own page: copying it into another page doesn't show the image there. To use the same image in another page, upload it there too, or have your AI app copy it (below). An image from elsewhere on the web keeps its normal `https://` address.

## Add images with an AI app

An AI app connected to Markdrop's [hosted MCP server](/ai/hosted-mcp) can add an image file to a page, and make it the page's cover or icon, without pasting the image into the chat:

1. `create_page_image_upload` with the page, the file's name, its size in bytes and its SHA-256. It returns a storage address and the exact `curl` command that sends the file there, straight from the computer the app runs commands on.
2. The app runs that command.
3. `complete_page_image_upload` checks the size, the SHA-256 and that the file really is a PNG, JPEG, GIF or WebP image, then adds it to the page. It returns `asset:<id>` and the Markdown to put in the page: `![Alt text](asset:<id>)`.

To make it the cover, the app calls `set_page_properties` with `cover` set to that `asset:<id>`; `icon` works the same way. A cover or icon must be an image of the same page.

Images added this way can be up to 20 MB. An upload that isn't finished within 6 hours is discarded. `copy_page_asset` copies an image of one page to another page, as a new image of that page: you must be able to read the first page and edit the second. `upload_page_image` still takes a small image as base64, up to 10 MB. See [Tools for AI apps](/ai/tools#pages).

## Related

- [Page Markdown reference](/pages/markdown-reference)
- [Tools for AI apps](/ai/tools)
