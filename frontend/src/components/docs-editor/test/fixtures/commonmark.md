---
title: "Every construct: CommonMark + GFM"
description: Fixture for the docs editor round trip.
updated: 2026-10-31
---


Setext heading
==============

Another one
-----------

# ATX h1 #

###### Six

Text with *emphasis*, _underscore emphasis_, **strong**, __underscore strong__, ***both***, ~~strike~~,
`code`, ``code with ` tick``, a [link](https://example.com "Title"), [relative](/docs/x#y), <https://auto.link>,
https://literal.example.com/path_with_underscores, www.example.com, mail me at someone@example.com,
an inline image ![badge](https://img.shields.io/badge/a-b-blue "Badge"), and an escaped \*star\* and \_under\_.
Hard break with backslash\
and with two spaces  
end. Entities: &copy; &amp; &#123; and a colon: 10:30, Note:this.

* star bullet
* second

+ plus bullet
+ second

1) paren ordered
2) second

3. starts at three
4. four

1. all ones
1. all ones
1. all ones

- tight
- list
  - nested
    - deeper
- back

- loose item

- with blank lines

  and a second paragraph

- [ ] task open
- [x] task done
- plain after tasks

> A quote
> over lines
>
> > nested quote
>
> - list in quote
> - second

---
***
___

    indented code
    block

```
plain fence
```

~~~python title="tilde.py" {1,3}
print("tilde")
~~~

````md
```nested```
````

| Left | Center | Right | None |
|:-----|:------:|------:|------|
| a    |   b    |     c | d    |
| `x\|y` | **bold** | [l](/l) | |

Some text[^1] and a [reference link][ref] and [shortcut] and ![ref image][img].

[ref]: https://example.com/ref "Ref title"
[shortcut]: /shortcut
[img]: /docs-assets/x.webp

[^1]: The footnote.

<div class="raw">
HTML block
</div>

<!-- a comment -->

Inline <span>html</span> here.

$$
E = mc^2
$$

Inline math $a^2 + b^2$ and money \$5.

Trailing paragraph without newline at the end of the line.
