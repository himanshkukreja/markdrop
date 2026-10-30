---
title: Directives
description: Every docs directive the engine renders, plus unknown ones.
icon: zap
updated: 2026-10-31
---

Intro with :kbd[⌘ K], :kbd[Ctrl] + :kbd[**Shift**], and plain text like 0:30 and ratio 16:9.

:::note
A note.
:::

:::tip[With a title]
A tip with **bold** and a list:

- one
- two
:::

:::warning{#warn-id .wide}
Warning with attributes.
:::

:::danger[Careful]
Danger.
:::

::::steps
### First
Do this.

```bash title="Install" wrap
npm install something --with-a-very-long-flag-that-wraps
```

### Second
:::note
Nested callout in a step.
:::

### Third
![A step image](/docs-assets/steps/third.webp "Caption under it")
::::

::::tabs{sync="os"}
:::tab[macOS]
Mac text.
:::
:::tab[Windows]
```powershell
irm https://example.com | iex
```
:::
:::tab[Linux]
Linux text.
:::
::::

::::cards
:::card[First card]{href="/a" icon="zap"}
Card body.
:::
:::card[No link]
Just text.
:::
::::

:::details[Show more]
Hidden body.

| a | b |
| --- | --- |
| 1 | 2 |
:::

::video{id="publish-first-document" title="Publish your first document" duration="0:32"}

::clip{src="/docs-assets/get-started/first-document/publish-from-new" alt="Typing and publishing" theme="both"}

::embed{src="https://example.com/demo" title="A demo"}

::api{op="GET /api/v1/documents/{id}"}

:::::steps
### Outer step
::::tabs
:::tab[A]
Deep.
:::
::::
:::::

:::unknown[Label]{x="1"}
Unknown container content.
:::

::unknownleaf{a="b"}

Text with :abbr[HTML]{title="HyperText"} unknown text directive.

:::tab[Stray tab]
A tab outside tabs.
:::

:::note
:::

- A list item with a callout:

  :::tip
  Inside a list item.
  :::

> :::note
> In a quote.
> :::
