/**
 * Section catalog for the Markdrop README / Markdown builder (/builder).
 *
 * Mirrors readme.so's section set (MIT, octokatherine/readme.so) and adds
 * Markdrop-only sections that our renderer can display live: Mermaid diagrams
 * (flowchart, sequence, gantt, pie, class, state, ER, git graph, mindmap,
 * journey), an xy chart, and a KaTeX math block.
 *
 * Authoring: `F` is the ``` code fence (template literals can't contain raw
 * backticks). The math block uses String.raw so LaTeX backslashes survive.
 * Default copy avoids inline `code` backticks for the same reason.
 */

const F = "```";

export type SectionGroup =
  | "Project basics"
  | "Documentation"
  | "Community"
  | "Diagrams"
  | "Math & data"
  | "GitHub profile"
  | "More";

export interface SectionTemplate {
  id: string;
  name: string;
  group: SectionGroup;
  icon: string; // emoji shown in the catalog
  markdown: string;
  /** Table of Contents — the builder offers a "generate from headings" action. */
  autoToc?: boolean;
}

export const GROUP_ORDER: SectionGroup[] = [
  "Project basics",
  "Documentation",
  "Community",
  "Diagrams",
  "Math & data",
  "GitHub profile",
  "More",
];

export const SECTION_TEMPLATES: SectionTemplate[] = [
  // ── Project basics ─────────────────────────────────────────────────────────
  {
    id: "title-and-description",
    name: "Title and Description",
    group: "Project basics",
    icon: "📌",
    markdown: `# Project Title

A short description of what this project does and who it's for.`,
  },
  {
    id: "badges",
    name: "Badges",
    group: "Project basics",
    icon: "🏷️",
    markdown: `[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)`,
  },
  {
    id: "logo",
    name: "Logo",
    group: "Project basics",
    icon: "🖼️",
    markdown: `![Logo](https://placehold.co/300x120?text=Your+Logo)`,
  },
  {
    id: "toc",
    name: "Table of Contents",
    group: "Project basics",
    icon: "🧭",
    autoToc: true,
    markdown: `## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)`,
  },
  {
    id: "demo",
    name: "Demo",
    group: "Project basics",
    icon: "🎬",
    markdown: `## Demo

Insert a gif or a link to a live demo.`,
  },
  {
    id: "screenshots",
    name: "Screenshots",
    group: "Project basics",
    icon: "📷",
    markdown: `## Screenshots

![App screenshot](https://placehold.co/800x400?text=Screenshot)`,
  },
  {
    id: "features",
    name: "Features",
    group: "Project basics",
    icon: "✨",
    markdown: `## Features

- Light/dark mode toggle
- Live previews
- Fullscreen mode
- Cross-platform`,
  },
  {
    id: "tech",
    name: "Tech Stack",
    group: "Project basics",
    icon: "🧱",
    markdown: `## Tech Stack

**Client:** React, Redux, TailwindCSS

**Server:** Node, Express`,
  },

  // ── Documentation ──────────────────────────────────────────────────────────
  {
    id: "installation",
    name: "Installation",
    group: "Documentation",
    icon: "📦",
    markdown: `## Installation

Install my-project with npm

${F}bash
npm install my-project
cd my-project
${F}`,
  },
  {
    id: "run-locally",
    name: "Run Locally",
    group: "Documentation",
    icon: "💻",
    markdown: `## Run Locally

Clone the project

${F}bash
git clone https://link-to-project
${F}

Go to the project directory

${F}bash
cd my-project
${F}

Install dependencies

${F}bash
npm install
${F}

Start the server

${F}bash
npm run start
${F}`,
  },
  {
    id: "usage-examples",
    name: "Usage / Examples",
    group: "Documentation",
    icon: "⚙️",
    markdown: `## Usage / Examples

${F}javascript
import Component from 'my-project'

function App() {
  return <Component />
}
${F}`,
  },
  {
    id: "env-variables",
    name: "Environment Variables",
    group: "Documentation",
    icon: "🔑",
    markdown: `## Environment Variables

To run this project, add the following environment variables to your .env file:

**API_KEY** — your service API key

**ANOTHER_API_KEY** — a second key`,
  },
  {
    id: "deployment",
    name: "Deployment",
    group: "Documentation",
    icon: "🚀",
    markdown: `## Deployment

To deploy this project run

${F}bash
npm run deploy
${F}`,
  },
  {
    id: "api",
    name: "API Reference",
    group: "Documentation",
    icon: "🔌",
    markdown: `## API Reference

#### Get all items

${F}http
GET /api/items
${F}

| Parameter | Type   | Description                |
| :-------- | :----- | :------------------------- |
| api_key   | string | **Required**. Your API key |

#### Get item

${F}http
GET /api/items/{id}
${F}

| Parameter | Type   | Description                       |
| :-------- | :----- | :-------------------------------- |
| id        | string | **Required**. Id of item to fetch |`,
  },
  {
    id: "tests",
    name: "Running Tests",
    group: "Documentation",
    icon: "🧪",
    markdown: `## Running Tests

To run tests, run the following command

${F}bash
npm run test
${F}`,
  },
  {
    id: "documentation",
    name: "Documentation",
    group: "Documentation",
    icon: "📚",
    markdown: `## Documentation

[Documentation](https://linktodocumentation)`,
  },

  // ── Community ──────────────────────────────────────────────────────────────
  {
    id: "contributing",
    name: "Contributing",
    group: "Community",
    icon: "🤝",
    markdown: `## Contributing

Contributions are always welcome!

See the contributing guide for ways to get started, and please adhere to this project's code of conduct.`,
  },
  {
    id: "license",
    name: "License",
    group: "Community",
    icon: "⚖️",
    markdown: `## License

[MIT](https://choosealicense.com/licenses/mit/)`,
  },
  {
    id: "authors",
    name: "Authors",
    group: "Community",
    icon: "👤",
    markdown: `## Authors

- [@yourhandle](https://www.github.com/yourhandle)`,
  },
  {
    id: "acknowledgements",
    name: "Acknowledgements",
    group: "Community",
    icon: "🙏",
    markdown: `## Acknowledgements

- [Awesome README](https://github.com/matiassingers/awesome-readme)
- [How to write a good README](https://bulldogjob.com/news/449-how-to-write-a-good-readme-for-your-github-project)
- [Choose an Open Source License](https://choosealicense.com)`,
  },
  {
    id: "support",
    name: "Support",
    group: "Community",
    icon: "🆘",
    markdown: `## Support

For support, email support@example.com or join our Slack channel.`,
  },
  {
    id: "feedback",
    name: "Feedback",
    group: "Community",
    icon: "💬",
    markdown: `## Feedback

If you have any feedback, please reach out to us at feedback@example.com`,
  },
  {
    id: "faq",
    name: "FAQ",
    group: "Community",
    icon: "❓",
    markdown: `## FAQ

#### Question 1

Answer 1

#### Question 2

Answer 2`,
  },
  {
    id: "used-by",
    name: "Used By",
    group: "Community",
    icon: "🏢",
    markdown: `## Used By

This project is used by the following companies:

- Company 1
- Company 2`,
  },
  {
    id: "related",
    name: "Related",
    group: "Community",
    icon: "🔗",
    markdown: `## Related

Here are some related projects

- [Awesome README](https://github.com/matiassingers/awesome-readme)`,
  },
  {
    id: "roadmap",
    name: "Roadmap",
    group: "Community",
    icon: "🗺️",
    markdown: `## Roadmap

- Additional browser support
- Add more integrations`,
  },

  // ── Diagrams (Mermaid) ──────────────────────────────────────────────────────
  {
    id: "mermaid-flowchart",
    name: "Flowchart",
    group: "Diagrams",
    icon: "🔀",
    markdown: `## Flowchart

${F}mermaid
graph TD
  A[Start] --> B{Works?}
  B -->|Yes| C[Ship it 🚀]
  B -->|No| D[Debug]
  D --> B
${F}`,
  },
  {
    id: "mermaid-sequence",
    name: "Sequence Diagram",
    group: "Diagrams",
    icon: "↔️",
    markdown: `## Sequence Diagram

${F}mermaid
sequenceDiagram
  participant U as User
  participant A as API
  U->>A: Request
  A-->>U: Response
${F}`,
  },
  {
    id: "mermaid-gantt",
    name: "Gantt Chart",
    group: "Diagrams",
    icon: "📅",
    markdown: `## Timeline

${F}mermaid
gantt
  title Project roadmap
  dateFormat YYYY-MM-DD
  section Build
  Design    :done,   d1, 2026-07-01, 3d
  Implement :active, d2, after d1, 5d
  section Ship
  Release   :        d3, after d2, 2d
${F}`,
  },
  {
    id: "mermaid-pie",
    name: "Pie Chart",
    group: "Diagrams",
    icon: "🥧",
    markdown: `## Breakdown

${F}mermaid
pie showData
  title Distribution
  "Category A" : 45
  "Category B" : 30
  "Category C" : 25
${F}`,
  },
  {
    id: "mermaid-xychart",
    name: "Bar / Line Chart",
    group: "Diagrams",
    icon: "📊",
    markdown: `## Chart

${F}mermaid
xychart-beta
  title "Monthly total"
  x-axis [Jan, Feb, Mar, Apr, May, Jun]
  y-axis "Value" 0 --> 120
  bar [30, 52, 48, 85, 70, 110]
  line [30, 52, 48, 85, 70, 110]
${F}`,
  },
  {
    id: "mermaid-class",
    name: "Class Diagram",
    group: "Diagrams",
    icon: "🧩",
    markdown: `## Class Diagram

${F}mermaid
classDiagram
  class Animal {
    +String name
    +move()
  }
  class Dog {
    +bark()
  }
  Animal <|-- Dog
${F}`,
  },
  {
    id: "mermaid-state",
    name: "State Diagram",
    group: "Diagrams",
    icon: "🔵",
    markdown: `## State Diagram

${F}mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Published : publish
  Published --> Draft : edit
  Published --> [*]
${F}`,
  },
  {
    id: "mermaid-er",
    name: "Entity Relationship",
    group: "Diagrams",
    icon: "🗄️",
    markdown: `## Data Model

${F}mermaid
erDiagram
  USER ||--o{ ORDER : places
  ORDER ||--|{ ITEM : contains
  USER {
    string name
    string email
  }
${F}`,
  },
  {
    id: "mermaid-gitgraph",
    name: "Git Graph",
    group: "Diagrams",
    icon: "🌿",
    markdown: `## Git Graph

${F}mermaid
gitGraph
  commit id: "init"
  branch feature
  checkout feature
  commit
  checkout main
  merge feature
  commit
${F}`,
  },
  {
    id: "mermaid-mindmap",
    name: "Mindmap",
    group: "Diagrams",
    icon: "🧠",
    markdown: `## Mindmap

${F}mermaid
mindmap
  root((Project))
    Frontend
      React
      Tailwind
    Backend
      API
      Database
${F}`,
  },
  {
    id: "mermaid-journey",
    name: "User Journey",
    group: "Diagrams",
    icon: "🧭",
    markdown: `## User Journey

${F}mermaid
journey
  title Onboarding
  section Sign up
    Visit site: 4: User
    Create account: 3: User
  section First use
    Explore: 5: User
${F}`,
  },

  // ── Math & data ─────────────────────────────────────────────────────────────
  {
    id: "math",
    name: "Math (KaTeX)",
    group: "Math & data",
    icon: "➗",
    markdown: String.raw`## Math

Inline math flows with text, e.g. $E = mc^2$.

$$
\int_{0}^{1} x^2 \, dx = \frac{1}{3}
$$

$$
f(x) = \frac{1}{\sigma\sqrt{2\pi}}\, e^{-\frac{1}{2}\left(\frac{x-\mu}{\sigma}\right)^2}
$$`,
  },
  {
    id: "table",
    name: "Table",
    group: "Math & data",
    icon: "📋",
    markdown: `## Comparison

| Feature   | Free | Pro |
| :-------- | :--: | :-: |
| Docs      |  ✅  | ✅  |
| Analytics |  ❌  | ✅  |
| Support   | Email | Priority |`,
  },
  {
    id: "color-reference",
    name: "Color Reference",
    group: "Math & data",
    icon: "🎨",
    markdown: `## Color Reference

| Color      | Hex         |
| ---------- | ----------- |
| Primary    | \`#1e293b\` |
| Accent     | \`#2563eb\` |
| Background | \`#0b0f1a\` |`,
  },

  // ── GitHub profile ───────────────────────────────────────────────────────────
  {
    id: "gh-intro",
    name: "Profile Intro",
    group: "GitHub profile",
    icon: "👋",
    markdown: `# Hi, I'm ... 👋`,
  },
  {
    id: "gh-about",
    name: "About Me",
    group: "GitHub profile",
    icon: "🙋",
    markdown: `## 🚀 About Me

I'm a full-stack developer who loves building useful tools.`,
  },
  {
    id: "gh-skills",
    name: "Skills",
    group: "GitHub profile",
    icon: "🛠️",
    markdown: `## 🛠 Skills

Javascript, Python, React, Node, TailwindCSS, Docker`,
  },
  {
    id: "gh-links",
    name: "Profile Links",
    group: "GitHub profile",
    icon: "🌐",
    markdown: `## 🔗 Links

[![portfolio](https://img.shields.io/badge/portfolio-000?style=for-the-badge&logo=about.me&logoColor=white)](https://example.com/)
[![linkedin](https://img.shields.io/badge/linkedin-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/)`,
  },
  {
    id: "gh-other",
    name: "Other (working on…)",
    group: "GitHub profile",
    icon: "💡",
    markdown: `## Other

- 👩‍💻 I'm currently working on ...
- 🧠 I'm currently learning ...
- 👯 I'm looking to collaborate on ...
- 📫 How to reach me: ...`,
  },

  // ── More ──────────────────────────────────────────────────────────────────
  {
    id: "optimizations",
    name: "Optimizations",
    group: "More",
    icon: "⚡",
    markdown: `## Optimizations

What optimizations did you make in your code? e.g. refactors, performance improvements, accessibility.`,
  },
  {
    id: "lessons",
    name: "Lessons Learned",
    group: "More",
    icon: "🎓",
    markdown: `## Lessons Learned

What did you learn while building this project? What challenges did you face and how did you overcome them?`,
  },
  {
    id: "appendix",
    name: "Appendix",
    group: "More",
    icon: "📎",
    markdown: `## Appendix

Any additional information goes here.`,
  },
  {
    id: "custom",
    name: "Custom section",
    group: "More",
    icon: "✏️",
    markdown: `## Section title

Write anything here.`,
  },
];

export const TEMPLATES_BY_ID: Record<string, SectionTemplate> = Object.fromEntries(
  SECTION_TEMPLATES.map((t) => [t.id, t])
);

/** GitHub-style heading slug for anchor links (used by the TOC generator). */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}
