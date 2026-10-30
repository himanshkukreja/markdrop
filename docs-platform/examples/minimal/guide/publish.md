---
title: Publish
description: How a build goes live without readers ever seeing half of it.
updated: 2026-10-30
---

A build is a set of objects named by their hash and one manifest. Publishing uploads the objects the
store doesn't have yet, then the manifest, then rewrites one small pointer file. Readers see the old
build until the pointer changes, and the new one after.

:::note
Rolling back is publishing the previous build again: every object is still there, so nothing uploads.
:::
