---
title: Build a README
description: Assemble a README from 49 ready-made sections, reorder them, see it render, then copy, download or publish it.
updated: 2026-10-30
keywords: [readme, builder, template, github profile, sections, readme.md]
---

The README builder at [markdrop.in/builder](https://markdrop.in/builder) puts a README together from ready-made sections: a title, badges, installation steps, a feature list, a license. You fill in the blanks, drag the sections into order, and watch the result render. Then you copy the Markdown, download `README.md`, or publish it as a Markdrop link. No account needed.

::video{id="readme-builder" title="Build a README" duration="0:39"}

## Build it

::::steps
### Add sections
Under **Add a section**, choose any section to add it to **Your README**. Search with **Search sections**. Sections are listed in these groups, and on a screen narrower than 1024 pixels you can also filter by group:

| Group | Includes |
| --- | --- |
| Project basics | Title and Description, Badges, Logo, Table of Contents, Demo, Screenshots, Features, Tech Stack |
| Documentation | Installation, Run Locally, Usage / Examples, Environment Variables, Deployment, API Reference, Running Tests, Documentation |
| Community | Contributing, License, Authors, Acknowledgements, Support, Feedback, FAQ, Used By, Related, Roadmap |
| Diagrams | Flowchart, Sequence Diagram, Gantt Chart, Pie Chart, Bar / Line Chart, Class Diagram, State Diagram, Entity Relationship, Git Graph, Mindmap, User Journey |
| Math & data | Math (KaTeX), Table, Color Reference |
| GitHub profile | Profile Intro, About Me, Skills, Profile Links, Other (working on…) |
| More | Optimizations, Lessons Learned, Appendix, Custom section |

![The README builder: Your README with five sections and the Add a section catalog on the left, the Installation section's Markdown in the middle, and the rendered Full README preview on the right.](/docs-assets/documents/readme-builder/builder-layout.webp)

### Fill them in
Select a section in **Your README** to edit its Markdown. The editor has the same formatting toolbar as [markdrop.in/new](https://markdrop.in/new). Type a title at the top, in **README title (optional)**.

### Put them in order
Drag a section by its handle. With a keyboard, press :kbd[Space] or :kbd[Enter] on the handle, move it with the arrow keys, and press :kbd[Space] or :kbd[Enter] again to drop it. Each section's menu also has **Move up**, **Move down**, **Duplicate** and **Remove**.

::clip{src="/docs-assets/documents/readme-builder/builder-reorder" alt="Dragging the Features section by its handle above Installation in Your README; the preview reorders to match."}

### Check the preview
The preview shows the **Full README** or **This section**, rendered the way readers will see it, diagrams and math included.
::::

The **Table of Contents** section can rebuild itself from your other sections' headings, so it stays in step as you add and reorder.

On a phone, the builder switches between **Sections**, **Edit** and **Preview** tabs.

## Take it with you

Open **Builder actions** (the `⋯` button):

- **Copy markdown** copies the whole README.
- **Download README.md** saves it as a file, ready to commit.
- **Reset builder…** clears everything and starts over.

Your work is saved in this browser as you go, so you can close the tab and come back to it.

:::note
Diagram and math sections render on Markdrop. GitHub renders Mermaid and math too, but other sites that show READMEs may show them as code.
:::

## Publish it as a link

Choose **Publish…**. The **Publish README** dialog has the same settings as any document: **Link**, **Who can open it**, **Encrypt in this browser**, **Password** and **Expires**, plus **Location** if you're in a workspace. Choose **Publish** and the README opens at its new link.

From then on it's an ordinary Markdrop document: edit it, share it, or check who read it. Later changes in the builder don't reach the published copy, and publishing again makes a new link. To update the same link, open the document, press :kbd[Esc] or choose **Show details** to leave full screen, and choose **Edit**.

## Related

- [Write and format documents](/documents/writing)
- [Publish your first document](/get-started/first-document)
- [Choose a link for your document](/documents/addresses)
