---
icon: 🚀
cover: gallery:aurora
---

## Launch plan {#b-k3x9a1}

A paragraph with :span[red text]{color="red"}, a :span[yellow highlight]{bg="yellow"}, :u[underlined words] and :span[**bold** in blue]{color=blue}.

A whole paragraph in green, with an anchor. {#b-p2q8z0 color="green"}

A paragraph on a gray background {bg="gray"}

### Heading in purple {color="purple"}

- First item {#b-li0001}
- Second item, highlighted {bg="pink"}
  - Nested under the second
- [ ] A to-do in orange {color="orange"}
- [x] Done

> A quote with an anchor {#b-qt0001}

::::columns
:::column{width="40%"}
### Left

Text in the left column.
:::

:::column{width="60%"}
Right column with an image:

![Diagram](asset:abc123xyz0 "The flow"){width="60%" align="center"}
:::
::::

:::::columns{#b-co1234}
::::column
:::note
A callout inside a column.
:::
::::

::::column
- a list
- in a column
::::

::::column
Third column.
::::
:::::

Parent paragraph for nested blocks.

::::indent
A child block, indented under the paragraph above.

:::indent
A grandchild.
:::
::::

![Left image](https://example.com/a.png){#b-im0001 width="35%" align="left"}

![Plain image](https://example.com/b.png)

```js
console.log("hello");
```
{#b-cd0001 caption="A small example"}

```bash
echo plain
```

| Name | Role {bg="blue"} | Notes |
| --- | --- | --- |
| Ada {bg="yellow"} | Owner | First |
| Ben | Member | Second {color="red"} |

{#b-tb0001 header-column widths="120,240,"}

| A | B |
| --- | --- |
| 1 | 2 |

---
{#b-hr0001}

$$
E = mc^2
$$
{#b-mt0001}

:::details{#b-tg0001 summary="A toggle with an anchor" color="blue"}
Hidden text.
:::

:::button{label="Add a task"}
- [ ] New task
:::

::bookmark{#b-bk0001 url="https://example.com"}

Text that ends like attributes but escaped \{color="red"}

Text with braces that are not attributes {like this}

A literal :span[that is not a colour]{size=big} stays as written.
