/**
 * A ```mermaid fence in the visual editor: the code block's view shows the diagram (views/code.tsx),
 * but the Markdown never changes. A long flowchart (11 nodes, edge labels, `<br/>` in labels, a
 * dotted edge, a class line) goes through the editor byte-identical, as one code block whose
 * language is exactly "mermaid" (the test the view and the reader both make).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { throughEditor } from "./helpers.mjs";

const LIFECYCLE = [
  "```mermaid",
  "flowchart TD",
  "    A[Idea<br/>from a customer call] --> B{Worth a doc?}",
  "    B -- yes --> C[Draft in the editor]",
  "    B -- no --> K[Parking lot]",
  "    C --> D[Review<br/>by the team]",
  "    D -->|changes| C",
  "    D -->|approved| E[Lock the page]",
  "    E --> F[Publish to the guide]",
  "    F --> G[Readers]",
  "    G -.->|feedback| H[Insights]",
  "    H --> I[Fix list]",
  "    I -.-> C",
  "    F --> J[(Archive)]",
  "    classDef done fill:#e6f4ea,stroke:#34a853",
  "    class F,G done",
  "```",
  "",
].join("\n");

const kinds = (json) => (json.content ?? []).map((n) => n.type);

test("a long mermaid flowchart round-trips byte-exact", () => {
  const { json, out } = throughEditor(LIFECYCLE);
  assert.equal(out, LIFECYCLE);
  assert.deepEqual(kinds(json), ["codeBlock"]);
  const block = json.content[0];
  assert.equal(block.attrs.language, "mermaid");
  assert.equal(block.content[0].text, LIFECYCLE.slice("```mermaid\n".length, -"```\n".length).replace(/\n$/, ""));
});

test("between paragraphs, with a caption and a title, it still round-trips byte-exact", () => {
  const md = `## The lifecycle\n\nHow a page moves.\n\n${LIFECYCLE.replace("```mermaid", '```mermaid title="Lifecycle"')}{caption="From idea to archive"}\n\nThe end.\n`;
  const { json, out } = throughEditor(md);
  assert.equal(out, md);
  assert.deepEqual(kinds(json), ["heading", "paragraph", "codeBlock", "paragraph"]);
  assert.equal(json.content[2].attrs.language, "mermaid");
});

test("only an exact `mermaid` fence is a diagram (as in the reader)", () => {
  for (const [fence, lang] of [
    ["```Mermaid", "Mermaid"],
    ["```mermaidjs", "mermaidjs"],
  ]) {
    const md = `${fence}\ngraph TD\n  A --> B\n\`\`\`\n`;
    const { json, out } = throughEditor(md);
    assert.equal(out, md);
    assert.equal(json.content[0].attrs.language, lang);
  }
});
