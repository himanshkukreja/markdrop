/**
 * Rich demo document used by the landing page's "Try it in a new doc" CTA
 * for the Mermaid / LaTeX / charts feature. Opening /new?sample=diagrams
 * pre-fills the editor with this and switches to split view so a first-time
 * user immediately sees the source alongside its rendered output.
 *
 * Authoring notes:
 * - `F` is the ``` code fence (kept in a constant so the fences below read
 *   cleanly inside template literals).
 * - The math section uses String.raw so LaTeX backslashes (\frac, \int, and
 *   \\ row breaks) survive verbatim — do NOT switch it to a plain template.
 */

const F = "```";

const INTRO = `# Diagrams, charts & math — live demo

Everything below is plain markdown. Markdrop renders **Mermaid** diagrams and
**KaTeX** math right in the page — no plugins, no build step. Edit the source on
the left and watch the preview update on the right.

> Tip: switch between **Write / Split / Preview** with the tabs above, then hit
> **Publish** to get a shareable \`markdrop.in\` link.`;

const MATH = String.raw`## 1. Math (KaTeX)

Inline math flows with your text — the mass–energy relation $E = mc^2$, or a sum
like $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$.

Display equations get their own centered block:

$$
\int_{0}^{1} x^2 \, dx = \left[ \frac{x^3}{3} \right]_0^1 = \frac{1}{3}
$$

The Gaussian / normal distribution:

$$
f(x) = \frac{1}{\sigma\sqrt{2\pi}}\, e^{-\frac{1}{2}\left(\frac{x-\mu}{\sigma}\right)^2}
$$

Matrices, alignment and cases all work:

$$
A = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}
\qquad
|x| = \begin{cases} x & x \ge 0 \\ -x & x < 0 \end{cases}
$$

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$`;

const FLOWCHART = `## 2. Flowchart

${F}mermaid
graph TD
  A[Write markdown] --> B{Contains a diagram?}
  B -->|Yes| C[Render with Mermaid]
  B -->|No| D[Render as markdown]
  C --> E[Publish 🚀]
  D --> E
${F}`;

const SEQUENCE = `## 3. Sequence diagram

${F}mermaid
sequenceDiagram
  participant U as You
  participant M as Markdrop
  participant V as Viewer
  U->>M: Publish markdown
  M-->>U: Shareable link
  U->>V: Send the link
  V->>M: Open document
  M-->>V: Rendered diagrams + math
${F}`;

const GANTT = `## 4. Gantt chart

${F}mermaid
gantt
  title Project roadmap
  dateFormat YYYY-MM-DD
  section Build
  Design       :done,    d1, 2026-07-01, 3d
  Implement    :active,  d2, after d1, 5d
  section Ship
  Review       :         d3, after d2, 2d
  Release      :         d4, after d3, 1d
${F}`;

const PIE = `## 5. Pie chart

${F}mermaid
pie showData
  title Where docs are shared
  "Direct link" : 45
  "VS Code"     : 25
  "Google Docs" : 18
  "P2P"         : 12
${F}`;

const XYCHART = `## 6. Bar & line chart

${F}mermaid
xychart-beta
  title "Monthly documents created"
  x-axis [Jan, Feb, Mar, Apr, May, Jun]
  y-axis "Documents" 0 --> 120
  bar [30, 52, 48, 85, 70, 110]
  line [30, 52, 48, 85, 70, 110]
${F}`;

const CLASS_DIAGRAM = `## 7. Class diagram

${F}mermaid
classDiagram
  class Document {
    +string slug
    +string title
    +string content
    +publish()
    +sync()
  }
  class User {
    +string email
    +Document[] docs
  }
  User "1" --> "*" Document : owns
${F}`;

const STATE = `## 8. State diagram

${F}mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Published : publish
  Published --> Draft : edit
  Published --> Expired : ttl reached
  Expired --> [*]
${F}`;

const ER = `## 9. Entity-relationship diagram

${F}mermaid
erDiagram
  USER ||--o{ DOCUMENT : owns
  DOCUMENT ||--o{ VIEW : records
  DOCUMENT {
    string slug
    string title
    int views
  }
${F}`;

const GITGRAPH = `## 10. Git graph

${F}mermaid
gitGraph
  commit id: "init"
  branch feature
  checkout feature
  commit id: "mermaid"
  commit id: "katex"
  checkout main
  merge feature
  commit id: "release"
${F}`;

const MINDMAP = `## 11. Mindmap

${F}mermaid
mindmap
  root((Markdrop))
    Publish
      Custom slug
      Password
      Expiry
    Render
      Mermaid
      KaTeX
      Charts
    Share
      P2P
      VS Code
      Google Docs
${F}`;

const JOURNEY = `## 12. User journey

${F}mermaid
journey
  title Publishing a doc
  section Create
    Paste markdown: 5: You
    Preview render: 4: You
  section Share
    Copy link: 5: You
    Open on phone: 4: Viewer
${F}`;

const CODE_AND_TABLE = `## 13. Code, tables & task lists

Regular fenced code still gets syntax highlighting:

${F}python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
${F}

| Feature        | Status      |
| -------------- | ----------- |
| Mermaid        | ✅ Shipped   |
| KaTeX math     | ✅ Shipped   |
| Charts         | ✅ Shipped   |

- [x] Diagrams render client-side
- [x] Math renders client-side
- [ ] Your turn — edit this and publish!`;

export const DIAGRAM_SAMPLE = {
  title: "Diagrams, charts & math — demo",
  content: [
    INTRO,
    MATH,
    FLOWCHART,
    SEQUENCE,
    GANTT,
    PIE,
    XYCHART,
    CLASS_DIAGRAM,
    STATE,
    ER,
    GITGRAPH,
    MINDMAP,
    JOURNEY,
    CODE_AND_TABLE,
  ].join("\n\n"),
};

/** Query-param value on /new that loads the sample above. */
export const DIAGRAM_SAMPLE_PARAM = "diagrams";
