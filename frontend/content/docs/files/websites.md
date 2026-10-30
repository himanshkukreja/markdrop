---
title: Publish a zipped website
description: Upload a .zip of a static site, like a docs build or a report with its own CSS and JS, and Markdrop serves it as a site at one link.
updated: 2026-10-30
prerequisites: [/get-started/first-file]
keywords: [zip, static site, bundle, website, index.html, multi-page, export]
---

Some pages don't fit in one file: a built docs site, a notebook export, a chart with its own CSS and JavaScript. Zip the folder and upload it, and Markdrop serves the whole thing as a site. It opens at its `index.html`, and links between its pages work.

::video{id="publish-zipped-site" title="Publish a zipped website" duration="0:40"}

## Publish it

::::steps
### Zip the folder
Zip the folder that holds your `index.html` and its files. On a Mac, right-click the folder and choose **Compress**. On Windows, right-click and choose **Send to › Compressed (zipped) folder**. From a terminal:

```bash
cd dist && zip -r ../site.zip .
```

### Upload the .zip
Go to [markdrop.in/upload](https://markdrop.in/upload) and drop `site.zip` in. Markdrop says it will render as "a multi-page site".

### Publish
Choose a **Title** and **Link**, then **Publish**. Markdrop unpacks the site ("Unpacking site…") and opens it at its new link.
::::

## Which page opens first

Markdrop opens `index.html` at the top of the zip. If there isn't one, it opens the `.html` file closest to the top.

If everything in the zip sits inside one folder, like `my-site/index.html`, Markdrop treats that folder as the top. Zipping a folder or zipping its contents gives the same result.

## How links and assets work

Every file keeps its path from the zip, side by side under the site's address. Relative links work as they do on your computer:

```html
<link rel="stylesheet" href="css/site.css">
<script src="js/app.js"></script>
<a href="guides/setup.html">Setup</a>
```

Two things to check before you zip:

- **Use relative paths.** A path starting with `/`, like `/css/site.css`, points at the root of the domain, not your site, and won't find the file.
- **Link to files, not folders.** Markdrop serves the exact file you name, so link to `guides/index.html`, not `guides/`.

## What's included

Markdrop keeps the files a web page uses:

| Kind | Extensions |
| --- | --- |
| Pages | `.html`, `.htm` |
| Styles and scripts | `.css`, `.js`, `.mjs`, `.map` |
| Data | `.json`, `.csv`, `.txt`, `.md`, `.webmanifest` |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.svg`, `.ico` |
| Fonts | `.woff`, `.woff2`, `.ttf`, `.otf` |
| Documents | `.pdf` |

Other files in the zip, including video, are skipped. So are macOS `__MACOSX` folders and hidden files.

## Limits

| What | Limit |
| --- | --- |
| The `.zip` itself | 25 MB |
| Files inside | 500 |
| Any one file inside | 25 MB |
| Everything inside, unpacked | 100 MB |

If a zip breaks a rule, Markdrop says which, for example "Archive has too many files (limit 500)." or "No .html file found — a bundle needs an index.html."

## Update a site

Open the site, press :kbd[Esc] or choose **Show details** to leave full screen, then choose **More artifact actions › Settings**, pick the new `.zip` under **File**, and choose **Save changes**. The link stays the same and the old files are removed.

A few things work differently from single files:

- Only the owner can replace a zipped site.
- Zipped sites don't keep earlier versions, so you can't restore an old one.
- Upload and replace zips in the browser. The CLI and the upload API don't take them.

## Related

- [Publish an HTML page](/files/html-pages)
- [Supported file types](/files/supported-types)
- [How files are served](/security/how-files-are-served)
