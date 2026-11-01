import type { Metadata } from "next";
import "@/docs/docs.css";
import "@/docs/themes.css";
import { DocsMarkdown } from "@/docs/render/DocsMarkdown";
import { THEME_FONT_FAMILIES } from "@/docs/themeFonts";
import PreviewFrame from "@/components/docs-sites/theme-builder/PreviewFrame";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Theme preview",
  robots: { index: false, follow: false },
};

/** The sample article: a callout of each kind, code, a table and cards, in the engine's own syntax. */
const ARTICLE = `Connect your first data source, invite your team and share a dashboard. It takes about ten minutes.

:::note
You need the **Admin** role to connect data sources. Ask an admin of your workspace if **Connect** is missing.
:::

## Install the CLI

Install the command-line tool, then sign in with your account. [Key concepts](/concepts) explains how projects and sources fit together, and \`acme help\` lists every command.

\`\`\`bash
npm install -g @acme/cli
acme login
acme projects create "Growth" --region eu
\`\`\`

:::tip[Use a token in CI]
Create a token under **Settings → Tokens** and set \`ACME_TOKEN\`. A token lasts until you revoke it.
:::

## Plans and limits

| Plan | Projects | Data sources | Support |
| --- | --- | --- | --- |
| Free | 3 | 2 | Community |
| Team | 20 | 10 | Email, next business day |
| Business | Unlimited | Unlimited | Priority, within 4 hours |

:::warning[Rate limits]
The API allows 600 requests a minute per token. Batch writes where you can.
:::

:::danger[Deleting a project]
Deleting a project removes its dashboards and history for everyone. It can't be undone.
:::

## Next steps

::::cards
:::card[Connect Postgres]{href="/guides/postgres" icon="link"}
Add a read-only user and connect in five minutes.
:::
:::card[Alert rules]{href="/guides/alerts" icon="alert"}
Get a message when a metric moves past a threshold.
:::
::::
`;

/**
 * The theme builder's live preview (components/docs-sites/theme-builder): sample guide pages in
 * the docs engine's markup and stylesheet, themed by whatever design the builder posts. Static,
 * no data of anyone's: the guide's name and logo arrive by postMessage from the same origin. Its
 * own route group, so it renders without the studio's chrome.
 */
export default function ThemePreviewPage() {
  return <PreviewFrame families={THEME_FONT_FAMILIES} article={<DocsMarkdown source={ARTICLE} />} />;
}
