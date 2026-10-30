---
title: Start here
description: What this example site is and how it is built.
updated: 2026-10-30
---

This folder is a complete docs site: `site.json` sets the name and the sidebar, and every page is a
Markdown file under a section folder.

## Build it

```bash
node docs-platform/builder/cli.mjs build docs-platform/examples/minimal --out /tmp/example-dist
```

## Serve it

```bash
node docs-platform/server/server.mjs start --content docs-platform/examples/minimal --data /tmp/example-data
```
