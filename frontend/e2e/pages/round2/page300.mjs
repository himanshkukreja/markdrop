/** The 300-block page used by perf.mjs and serialize-bench.mjs: every round 2 construct, repeated. */
const COLORS = ["red", "blue", "green", "purple", "orange"];
export function page300() {
  const out = [];
  for (let i = 0; out.length < 300; i++) {
    const k = i % 12;
    if (k === 0) out.push(`## Section ${i} {#b-s${String(i).padStart(4, "0")}}`);
    else if (k === 1) out.push(`Paragraph ${i} with **bold**, :span[colour]{color="${COLORS[i % 5]}"}, :u[underline] and a [link](https://example.com/${i}). Some more words to make the line longer than one line on the page.`);
    else if (k === 2) out.push(`- item ${i} a\n- item ${i} b {bg="yellow"}\n  - nested ${i}`);
    else if (k === 3) out.push(`- [ ] task ${i}\n- [x] done ${i}`);
    else if (k === 4) out.push(`:::note\nA callout ${i} with text.\n:::`);
    else if (k === 5) out.push("```js\nconst x = " + i + ";\nconsole.log(x);\n```\n{caption=\"Example " + i + "\"}");
    else if (k === 6) out.push(`| A | B | C |\n| --- | --- | --- |\n| ${i} | b {bg="blue"} | c |\n| d | e | f |\n\n{header-column widths="120,200,"}`);
    else if (k === 7) out.push(`::::columns\n:::column{width="40%"}\nLeft ${i}\n:::\n\n:::column{width="60%"}\nRight ${i}\n:::\n::::`);
    else if (k === 8) out.push(`> Quote ${i} {color="gray"}`);
    else if (k === 9) out.push(`Parent ${i}\n\n:::indent\nChild ${i}\n:::`);
    else if (k === 10) out.push(`:::details{summary="Toggle ${i}"}\nHidden ${i}\n:::`);
    else out.push(`Plain paragraph number ${i}, just text.`);
  }
  return out.join("\n\n") + "\n";
}
