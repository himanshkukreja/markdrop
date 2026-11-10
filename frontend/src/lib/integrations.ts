/**
 * The integrations catalog: every card on the two Integrations grids and the words on each one's
 * detail page. Workspace integrations (Workspace settings › Integrations, /settings/workspaces/<id>/integrations/<id>)
 * are set up once for the workspace; account integrations (Settings › Integrations, /settings/integrations/<id>)
 * are each person's own. Status comes from the existing APIs (components/integrations/useIntegrationStatus).
 * The settings and forms on the detail pages are the same components that used to sit on the long page.
 */
import type { DocsTopic } from "@/lib/docsLinks";

export type BrandId =
  | "slack" | "jira" | "zoom" | "google-meet" | "google-docs" | "github" | "claude" | "chatgpt" | "cursor" | "vscode";

export type IntegrationScope = "workspace" | "account";

export type IntegrationGroup = "Meetings" | "Chat" | "Work tracking" | "AI apps" | "Documents" | "Developer";

export interface IntegrationStep { title: string; body?: string }

export interface IntegrationInfo {
  id: string;
  scope: IntegrationScope;
  name: string;
  group: IntegrationGroup;
  /** A brand mark (public/brands) or, for Markdrop's own tools, a Lucide icon name. */
  brand?: BrandId;
  icon?: string;
  /** One line on the card. */
  blurb: string;
  /** "What it does" on the detail page. */
  what: string[];
  steps: IntegrationStep[];
  troubleshooting: Array<{ q: string; a: string }>;
  docs: DocsTopic;
}

const WORKSPACE: IntegrationInfo[] = [
  {
    id: "zoom", scope: "workspace", name: "Zoom", group: "Meetings", brand: "zoom",
    blurb: "Recorded Zoom meetings come in as meeting notes for one team.",
    what: [
      "Recorded meetings hosted by the chosen team's members become meetings in that team, with a summary, decisions and action items.",
      "Admins and the team's leads bring in past meetings.",
      "Meetings hosted by anyone else are ignored.",
    ],
    steps: [
      { title: "Create the Zoom app", body: "Your Zoom account admin creates the app in the Zoom App Marketplace, following the steps under Settings below." },
      { title: "Connect it here", body: "A workspace admin pastes the app's details; Markdrop checks them with Zoom." },
      { title: "Pick the team", body: "Choose whose meetings come in. Make the team private so only its members see them." },
      { title: "Bring in past meetings", body: "Optional: Import past meetings picks recordings from a date range." },
    ],
    troubleshooting: [
      { q: "Nothing comes in", a: "Check that a team is picked and that the meeting was recorded to the cloud with audio transcripts on." },
      { q: "“The Zoom connection needs attention”", a: "Zoom stopped accepting the app's credentials or scopes are missing. Fix it in Zoom, then save the credentials again." },
    ],
    docs: "zoomIntegration",
  },
  {
    id: "google-meet", scope: "workspace", name: "Google Meet", group: "Meetings", brand: "google-meet",
    blurb: "Your Meet transcripts and Gemini notes come in automatically.",
    what: [
      "A small script in your own Google account sends new Meet transcripts and Gemini notes to this workspace every 5 minutes.",
      "Each one becomes a meeting with a summary, decisions and action items.",
      "Each person connects their own Google account; disconnect any time.",
    ],
    steps: [
      { title: "Choose Connect Google Meet", body: "Pick who sees the meetings and how far back to start." },
      { title: "Copy the script", body: "Markdrop makes a ready-to-paste Google Apps Script with a token that can only add meetings here." },
      { title: "Paste it in Apps Script", body: "Open script.google.com, paste the script and its manifest, and run it once to allow it." },
      { title: "Check it works", body: "Your next Meet transcript shows up in Meetings within a few minutes." },
    ],
    troubleshooting: [
      { q: "No meetings arrive", a: "Meet only saves transcripts when transcription is turned on in the call. Use Check for new meetings to run the script now." },
      { q: "“Get the new script”", a: "Markdrop updated the script. Connect again and paste the new one; the old token stops working." },
    ],
    docs: "meetingsAutoImport",
  },
  {
    id: "slack", scope: "workspace", name: "Slack", group: "Chat", brand: "slack",
    blurb: "Meeting notes in a channel, /markdrop search and ask, and link previews.",
    what: [
      "Each imported meeting's summary, decisions and action items go to a channel, with Done buttons.",
      "/markdrop search and /markdrop ask answer from what each person can open, privately.",
      "Each attendee can get their own action items as a direct message after a meeting.",
      "Markdrop links unfurl into previews.",
    ],
    steps: [
      { title: "Add to Slack", body: "A workspace admin chooses Add to Slack and approves Markdrop in Slack." },
      { title: "Pick the meetings channel", body: "For a private channel, first type /invite @Markdrop in it." },
      { title: "Link your Slack account", body: "Everyone links once so /markdrop answers them and Done buttons work." },
      { title: "Turn on Slack notifications", body: "Optional, per person: mentions, sign-offs, shares and access requests as direct messages." },
    ],
    troubleshooting: [
      { q: "“Update Markdrop for Slack”", a: "Slack needs two more permissions to find people by email. An admin chooses Update permissions." },
      { q: "“Slack's connection broke”", a: "Disconnect, then add Markdrop to Slack again." },
      { q: "A private channel isn't in the list", a: "Type /invite @Markdrop in that channel, then reload this page." },
    ],
    docs: "slackIntegration",
  },
  {
    id: "jira", scope: "workspace", name: "Jira", group: "Work tracking", brand: "jira",
    blurb: "Create issues from meetings and pages, and see tickets on Team.",
    what: [
      "Create Jira issues from action items, decisions, Team blockers and any text in a page; Markdrop AI drafts them and you review.",
      "Linked to-dos and issues stay in step both ways.",
      "Each person's tickets show on Team, and you can ask about them.",
      "Everything in Jira happens as the person doing it, through their own Atlassian account.",
    ],
    steps: [
      { title: "Connect the Jira site", body: "A workspace admin chooses Connect Jira and approves Markdrop in Atlassian." },
      { title: "Choose the projects", body: "Pick the projects that feed Team, and the default project and issue type." },
      { title: "Connect your Atlassian account", body: "Each person connects their own account so issues are created and moved as them." },
    ],
    troubleshooting: [
      { q: "“No access” next to the site", a: "Your Atlassian account doesn't reach that Jira site. Ask its Jira admin for access." },
      { q: "Issues don't update in Markdrop", a: "The Jira webhook may have expired. An admin opens Change projects and saves again." },
    ],
    docs: "jiraIntegration",
  },
];

const ACCOUNT: IntegrationInfo[] = [
  {
    id: "claude", scope: "account", name: "Claude", group: "AI apps", brand: "claude",
    blurb: "Publish, find and edit your Markdrop work from Claude.",
    what: [
      "Claude publishes documents and pages, reads what you can open, and searches your workspaces.",
      "Works on claude.ai, Claude Desktop and Claude Code.",
      "You approve it here once; disconnect any time.",
    ],
    steps: [
      { title: "Open Settings › Connectors in Claude", body: "On claude.ai or in Claude Desktop." },
      { title: "Add a custom connector", body: "Name it Markdrop and paste the server URL below." },
      { title: "Connect and approve", body: "Markdrop opens in your browser: sign in and approve." },
      { title: "Ask Claude", body: "For example: publish this as a Markdrop page." },
    ],
    troubleshooting: [
      { q: "Add custom connector is missing", a: "On Team and Enterprise plans an owner may need to add the connector for the organisation first." },
      { q: "Claude Code", a: "Run claude mcp add --transport http markdrop with the server URL, then /mcp to sign in." },
    ],
    docs: "connectAiApp",
  },
  {
    id: "chatgpt", scope: "account", name: "ChatGPT", group: "AI apps", brand: "chatgpt",
    blurb: "Use Markdrop from ChatGPT with Developer mode.",
    what: [
      "ChatGPT publishes documents and pages and reads what you can open.",
      "You approve it here once; disconnect any time.",
    ],
    steps: [
      { title: "Turn on Developer mode", body: "In ChatGPT: Settings › Apps & Connectors › Advanced settings." },
      { title: "Create the connector", body: "In Apps & Connectors choose Create, name it Markdrop, paste the server URL and pick OAuth." },
      { title: "Sign in and approve", body: "Markdrop opens in your browser." },
    ],
    troubleshooting: [
      { q: "Developer mode is missing", a: "It needs a Pro, Team, Enterprise or Edu plan." },
    ],
    docs: "connectAiApp",
  },
  {
    id: "cursor", scope: "account", name: "Cursor", group: "AI apps", brand: "cursor",
    blurb: "Publish from your editor's agent with Markdrop's MCP server.",
    what: [
      "Cursor's agent publishes documents and pages and reads what you can open.",
      "You approve it here once; disconnect any time.",
    ],
    steps: [
      { title: "Add the server", body: "Add Markdrop to ~/.cursor/mcp.json, or .cursor/mcp.json in one project, with the server URL below." },
      { title: "Sign in", body: "Open Cursor's MCP settings and sign in to markdrop when it asks." },
      { title: "Approve", body: "Markdrop opens in your browser to approve." },
    ],
    troubleshooting: [
      { q: "Cursor doesn't ask to sign in", a: "Restart Cursor after editing mcp.json, then open its MCP settings." },
    ],
    docs: "connectAiApp",
  },
  {
    id: "ai-apps", scope: "account", name: "Other AI apps", group: "AI apps", icon: "sparkle",
    blurb: "Any app that speaks MCP: VS Code Copilot, Windsurf and more.",
    what: [
      "Any MCP app that connects to remote servers can use Markdrop with one server URL.",
      "There is no client ID, secret or API key to paste: the app registers itself and you approve it here.",
    ],
    steps: [
      { title: "Add a remote MCP server", body: "Paste the server URL. The transport is Streamable HTTP." },
      { title: "Choose OAuth", body: "Pick OAuth for authentication." },
      { title: "Sign in and approve", body: "Markdrop opens in your browser." },
    ],
    troubleshooting: [
      { q: "The app asks for an API key", a: "Use a Markdrop API token only if the app can't do OAuth; create one under API tokens." },
    ],
    docs: "connectAiApp",
  },
  {
    id: "slack", scope: "account", name: "Slack", group: "Chat", brand: "slack",
    blurb: "Your own Markdrop notifications as Slack messages.",
    what: [
      "Mentions, sign-off requests, shares and access requests as direct messages, for the kinds you pick.",
      "Approve or decline right in Slack.",
      "Off until you turn it on. Action items after meetings are separate, and on by default.",
    ],
    steps: [
      { title: "Have Slack in a workspace", body: "A workspace admin connects Slack in Workspace settings › Integrations." },
      { title: "Turn on Slack notifications", body: "Markdrop finds you in Slack by your sign-in email." },
      { title: "Link your account if needed", body: "Where your email doesn't match, choose Link my Slack account." },
    ],
    troubleshooting: [
      { q: "Slack isn't listed", a: "None of your workspaces has Slack connected yet. Ask a workspace admin." },
      { q: "“Not found in Slack”", a: "Your Slack email differs from your Markdrop email. Link your Slack account instead." },
    ],
    docs: "slackNotifications",
  },
  {
    id: "jira", scope: "account", name: "Jira", group: "Work tracking", brand: "jira",
    blurb: "Your own Atlassian account, so issues are created as you.",
    what: [
      "Markdrop creates and moves Jira issues as you.",
      "Team and Ask show only tickets you can open in Jira.",
    ],
    steps: [
      { title: "Connect your Atlassian account", body: "Approve Markdrop in Atlassian." },
      { title: "Check your sites", body: "Each workspace's Jira site shows whether your account reaches it." },
    ],
    troubleshooting: [
      { q: "“No access”", a: "Ask that site's Jira admin for access." },
      { q: "“Reconnect”", a: "Your Atlassian connection stopped working. Connect it again." },
    ],
    docs: "jiraIntegration",
  },
  {
    id: "google-docs", scope: "account", name: "Google Docs", group: "Documents", brand: "google-docs",
    blurb: "Publish a document to Google Docs and keep it in sync.",
    what: [
      "Publish any of your documents to Google Docs, then sync it when the document changes.",
      "Markdrop only sees the Google Docs it created.",
    ],
    steps: [
      { title: "Connect Google Docs", body: "Approve Markdrop in Google." },
      { title: "Open a document", body: "In its details, choose Publish to Google Docs." },
      { title: "Sync later", body: "When the document changes, choose Sync to Google Docs." },
    ],
    troubleshooting: [
      { q: "“Reconnect Google”", a: "Google revoked Markdrop's access. Disconnect here, then connect again." },
    ],
    docs: "googleDocs",
  },
  {
    id: "github", scope: "account", name: "GitHub", group: "Documents", brand: "github",
    blurb: "Import a guide from a GitHub repository and keep it in step.",
    what: [
      "Markdrop Guides imports Markdown from a GitHub repository and can follow new commits.",
      "You connect GitHub from each guide, for the repositories you choose.",
    ],
    steps: [
      { title: "Open Guides", body: "Create a guide, or open one." },
      { title: "Import from GitHub", body: "Install the Markdrop GitHub app on the repositories you pick." },
      { title: "Choose the folder", body: "Pick the folder with your Markdown and how it syncs." },
    ],
    troubleshooting: [
      { q: "A repository isn't listed", a: "Give the Markdrop GitHub app access to it in GitHub's settings." },
    ],
    docs: "studioGithub",
  },
  {
    id: "vscode", scope: "account", name: "VS Code", group: "Developer", brand: "vscode",
    blurb: "Markdrop Sync: publish Markdown from VS Code and sync both ways.",
    what: [
      "Publish a Markdown file from VS Code and keep it in sync with its Markdrop link.",
      "Edits on either side come across, and conflicts are shown side by side.",
    ],
    steps: [
      { title: "Install Markdrop Sync", body: "From the Visual Studio Marketplace, or: code --install-extension HimanshuKukreja.markdrop" },
      { title: "Sign in", body: "Run Markdrop: Sign in from the Command Palette and approve in your browser." },
      { title: "Publish a file", body: "Run Markdrop: Publish on a Markdown file." },
    ],
    troubleshooting: [
      { q: "The browser doesn't return to VS Code", a: "Create an API token and run Markdrop: Sign in with API token." },
    ],
    docs: "vscode",
  },
  {
    id: "cli", scope: "account", name: "Markdrop CLI", group: "Developer", icon: "terminal",
    blurb: "Publish, upload and send files from your terminal.",
    what: [
      "Publish documents, upload and replace files, and send files peer to peer from a terminal or a script.",
      "Includes a local MCP server for AI apps that read files from your computer.",
    ],
    steps: [
      { title: "Install it", body: "macOS: brew install himanshkukreja/tap/markdrop. Windows and Linux: see the docs." },
      { title: "Create an API token", body: "Under API tokens, one per device." },
      { title: "Sign in", body: "Run markdrop login and paste the token." },
    ],
    troubleshooting: [
      { q: "“no Markdrop API token”", a: "Run markdrop login, or set MARKDROP_TOKEN." },
    ],
    docs: "cliInstall",
  },
];

export const WORKSPACE_INTEGRATIONS = WORKSPACE;
export const ACCOUNT_INTEGRATIONS = ACCOUNT;

export const GROUP_ORDER: IntegrationGroup[] = ["Meetings", "Chat", "Work tracking", "AI apps", "Documents", "Developer"];

export function findIntegration(scope: IntegrationScope, id: string): IntegrationInfo | null {
  return (scope === "workspace" ? WORKSPACE : ACCOUNT).find((i) => i.id === id) ?? null;
}

/** Where an integration's detail page lives. */
export function integrationHref(scope: IntegrationScope, id: string, workspaceId?: string): string {
  return scope === "workspace"
    ? `/settings/workspaces/${encodeURIComponent(workspaceId ?? "")}/integrations/${id}`
    : `/settings/integrations/${id}`;
}

/** The grid an integration's detail page goes back to. */
export function gridHref(scope: IntegrationScope, workspaceId?: string): string {
  return scope === "workspace" ? `/settings/workspaces/${encodeURIComponent(workspaceId ?? "")}?tab=integrations` : "/settings/integrations";
}

/** Old `?tab=` names on workspace settings that now open one integration's page. */
export const OLD_WORKSPACE_TABS: Record<string, string> = { slack: "slack", jira: "jira", zoom: "zoom", meet: "google-meet" };

/** Old `/settings/account#…` anchors that now open one account integration's page. */
export const OLD_ACCOUNT_ANCHORS: Record<string, string> = { slack: "slack", jira: "jira" };

/** A connected AI app (OAuth client) → the card it belongs to, by its registered name. */
export function aiAppOf(name: string): "claude" | "chatgpt" | "cursor" | "ai-apps" {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("chatgpt") || n.includes("openai")) return "chatgpt";
  if (n.includes("cursor")) return "cursor";
  return "ai-apps";
}
