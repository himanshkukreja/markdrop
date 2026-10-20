# Changelog

## 0.3.1

**Large HTML files publish again, and failures say why.**

- HTML and other files up to 25 MB now publish and sync (the server limit was
  10 MB, so self-contained pages with inlined images or fonts failed).
- A file over the limit is caught before uploading, with its size and what to do.
- Errors show the server's reason instead of "Failed to publish to Markdrop".
- Very long filenames are shortened to fit the link instead of being refused.
- A sync refusal (for example an encrypted document) is shown as a message
  instead of opening an empty conflict.

## 0.3.0

**HTML and text files now sync too.**

- Publish `.html`, `.txt`, `.csv`, `.json` and `.svg` alongside Markdown. A
  Markdown file publishes as a document; the others publish as **artifacts**, so
  the link renders the page instead of showing escaped source.
- Titles come from `<title>` or the first `<h1>` for HTML, falling back to the
  filename, matching how Markdown already uses its first heading.
- Conflict diffs open with the source file's own extension, so HTML is
  highlighted as HTML rather than Markdown.
- Push-on-save, background pull and the conflict resolver work exactly as before
  — the sync protocol is unchanged.

Binary formats (PDF, Word, Excel, zipped sites) are deliberately not syncable:
they have no meaningful editor representation, so the server refuses rather than
handing over bytes that can't round-trip. Upload those at
[markdrop.in/upload](https://markdrop.in/upload) instead.

## 0.2.0

- Two-way sync: background polling pulls web edits back into the editor, with a
  side-by-side diff and Keep mine / Use web / Merge when both sides changed.
- Status bar showing signed-in, publish, synced and unsynced states.

## 0.1.0

- Publish the active Markdown file to Markdrop and push on save.
- Sign in from the browser via a `vscode://` deep link, or paste an API token.
