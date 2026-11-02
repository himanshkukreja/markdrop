import type { Metadata } from "next";
import { ButtonLink, Icon } from "@/components/landing/ds";
import { CommandBlock } from "@/components/kit/CommandBlock";
import { SnapPage } from "@/components/marketing/snap/Snap";
import { FaqList, Feature, LoopShot, Mat, More, parts as p, type Faq } from "@/components/marketing/snap/Parts";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { MCP_LOCAL_MIN_CLI, MCP_LOCAL_SERVER, MCP_LOCAL_TOOL_GROUPS, MCP_SERVER_URL, MCP_TOOL_COUNT, MCP_TOOL_GROUPS } from "@/lib/mcp";
import { ConnectTabs } from "./ConnectTabs";
import m from "./mcp.module.css";

const TITLE = "Markdrop for AI assistants — MCP server";
const DESCRIPTION =
  "Connect Claude, ChatGPT, Cursor and other AI apps to Markdrop. Publish what your assistant writes as a link, and read and update your documents from a chat.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/mcp" },
  openGraph: { title: "Markdrop for AI assistants", description: DESCRIPTION, url: "/mcp", type: "website", siteName: "Markdrop" },
  twitter: { card: "summary", title: "Markdrop for AI assistants", description: DESCRIPTION },
};

const docs = (k: keyof typeof DOCS_PAGES) => docsUrl(DOCS_PAGES[k]);
const LOCAL_COUNT = MCP_LOCAL_TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0);

/** Where the recordings come from (series video 09, docs-media stack): said once, under each loop. */
const RECORDED = "A neutral chat app making real calls to Markdrop's MCP server, with fictional data.";

const FAQ: Faq[] = [
  {
    q: "Do I need a Markdrop account?",
    a: <>Yes, a free one: the assistant publishes and reads as you. You can create one with just an email address when the app sends you to Markdrop.</>,
  },
  { q: "Does it cost anything?", a: <>No. Connecting an app and using the tools is free.</> },
  {
    q: "Which AI apps work with it?",
    a: <>Any MCP app that connects to remote servers and signs in with OAuth: Claude, Claude Code, ChatGPT, Cursor, VS Code, Windsurf and others.</>,
  },
  { q: "Why can't I find Developer mode in ChatGPT?", a: <>ChatGPT adds custom MCP servers through Developer mode, which needs a Pro, Team, Enterprise or Edu plan.</> },
  {
    q: "What can the assistant open?",
    a: (
      <>
        What you could open yourself: your documents, what you can open in your workspaces or was shared with you, and links anyone can open. Never
        past a password, encryption, private access or a workspace&apos;s sign-in.
      </>
    ),
  },
  {
    q: "Is my data used to train AI models?",
    a: (
      <>
        Markdrop doesn&apos;t sell your data. What the assistant reads from Markdrop becomes part of your conversation with it, so your AI provider&apos;s
        own data policy applies to that conversation.
      </>
    ),
  },
  {
    q: "How do I disconnect an app?",
    a: (
      <>
        Open <a href="/settings/connections">Settings › Connected apps</a> and choose Disconnect. The app loses access straight away; what it published
        stays yours, with the same links.
      </>
    ),
  },
];

/** The hosted server's tools, grouped, with the permission each needs (lib/mcp, docs: ai/tools). */
function ToolsPanel() {
  return (
    <div className={`${p.panel} ${m.tools}`}>
      <div className={m.toolsHead}>
        <span>
          <b>{MCP_TOOL_COUNT} tools</b> · api.markdrop.in/mcp
        </span>
        <span className={m.legend} aria-hidden="true">
          <span className={m.key}>
            <i />
            read
          </span>
          <span className={m.key} data-write="">
            <i />
            write
          </span>
        </span>
      </div>
      <div className={m.groups}>
        {MCP_TOOL_GROUPS.map((g) => (
          <div key={g.title} className={m.group}>
            <h3>
              <Icon name={g.icon} />
              {g.title}
            </h3>
            <ul className={m.chips}>
              {g.tools.map((t) => (
                <li key={t.name} className={m.chip} data-write={t.scope === "write" ? "" : undefined}>
                  {t.name}
                  <span className="sr-only"> ({t.scope === "write" ? "documents:write" : "documents:read"})</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className={m.local}>
        <b>On your computer,</b> the local server ({MCP_LOCAL_SERVER}) adds {LOCAL_COUNT} more: publishing files from disk, workspaces, and sending and receiving share links.
      </p>
    </div>
  );
}

/**
 * /mcp: what Markdrop's MCP server does and how to connect an AI app to it. Seven one-viewport
 * sections that snap from 1024 × 640 (SnapPage / Feature, components/marketing/snap): the hero with
 * the server URL, connecting an app, what to ask, the tools, the local server, permissions and
 * privacy, questions. The loops are real recordings (series video 09); facts follow docs ai/*. Static.
 */
export default function McpPage() {
  return (
    <SnapPage>
      <Feature
        id="top"
        hero
        eyebrow="MCP server"
        title={
          <>
            Your AI app, <span className={p.accent}>publishing to Markdrop.</span>
          </>
        }
        lede="Claude, ChatGPT, Cursor and other AI apps publish what they write as a link that renders, and read, update and share your documents from a chat."
        extra={
          <div className={m.url}>
            <CommandBlock command={MCP_SERVER_URL} prompt="" label="Server URL" copyLabel="Copy server URL" />
            <p>
              <Icon name="info" />
              <span>Paste it into your AI app, then sign in to Markdrop and approve. Free with a Markdrop account.</span>
            </p>
          </div>
        }
        actions={
          <>
            <ButtonLink href="#connect" variant="primary" iconRight="arrowDown" data-cta="mcp_connect">
              Connect your app
            </ButtonLink>
            <More href={docs("aiOverview")} cta="mcp_docs">
              How it works
            </More>
          </>
        }
        visual={
          <LoopShot
            name="mcp-publish"
            w={984}
            h={756}
            addr={<b>Your AI app</b>}
            tag="Markdrop connected"
            tagIcon="check"
            tagOn
            caption={RECORDED}
            label="An AI app asked to turn meeting notes into a Markdrop doc: it calls Markdrop's publish_document tool, which says Done and Published: https://markdrop.in/launch-sync, and the app answers with the link markdrop.in/launch-sync."
          />
        }
      />

      <Feature
        id="connect"
        rev
        eyebrow="Set up"
        title="One URL, then you approve."
        lede="Add Markdrop as a connector, sign in on Markdrop and approve the app. No API key, client ID or secret to paste."
        points={[
          { icon: "sparkle", title: "Claude, Claude Code, ChatGPT, Cursor, VS Code, Windsurf", text: "and any MCP app that connects to remote servers with OAuth." },
          { icon: "checkCircle", title: "You see what it asks for", text: "before you approve. Cancel, and nothing is shared." },
        ]}
        actions={
          <More href={docs("connectAiApp")} cta="mcp_connect_docs">
            The full guide
          </More>
        }
        visual={
          <Mat>
            <div className={m.connect}>
              <ConnectTabs />
            </div>
          </Mat>
        }
      />

      <Feature
        id="ask"
        eyebrow="Try it"
        title="Ask in plain words."
        lede="Say it the way you would to a colleague. Your assistant picks the tool."
        points={[
          { icon: "message", title: "“Turn these meeting notes into a Markdrop doc.”", text: <code>publish_document</code> },
          { icon: "message", title: "“Build an HTML dashboard of this CSV and publish it.”", text: <code>publish_page</code> },
          { icon: "message", title: "“Make the Q3 board deck private.”", text: <code>set_access</code> },
          { icon: "message", title: "“How many people read my launch notes?”", text: <code>get_document_analytics</code> },
          { icon: "message", title: "“Put the onboarding guide in Acme's guides/setup folder.”", text: <code>move_to_folder</code> },
        ]}
        visual={
          <LoopShot
            name="mcp-manage"
            w={984}
            h={756}
            addr={<b>Your AI app</b>}
            tag="Markdrop connected"
            tagIcon="check"
            tagOn
            caption={RECORDED}
            label="An AI app asked to make the Q3 board deck private calls set_access, and docs.acme.com/sales/q3-board-deck becomes visible to only its owner; asked how many people read the launch notes, it calls get_document_analytics and answers: 28 views from 19 people in the last 30 days, up 155%, and most readers stop after Docs and enablement."
          />
        }
      />

      <Feature
        id="tools"
        rev
        eyebrow="Tools"
        title={`${MCP_TOOL_COUNT} tools, two permissions.`}
        lede={
          <>
            Each tool needs <code>documents:read</code> or <code>documents:write</code>, and an app gets only the permissions you approved.
          </>
        }
        points={[
          { icon: "upload", title: "Publish and manage:", text: "documents, HTML pages, uploads up to 2 GB, versions, access and deletes." },
          { icon: "eye", title: "Read and find:", text: "your documents, workspaces and folders, analytics, and your share links." },
        ]}
        actions={
          <More href={docs("aiTools")} cta="mcp_tools_docs">
            Every tool, with its inputs
          </More>
        }
        visual={
          <Mat>
            <ToolsPanel />
          </Mat>
        }
      />

      <Feature
        id="on-your-computer"
        eyebrow="On your computer"
        title="Send files and publish from disk."
        lede={
          <>
            Markdrop&apos;s local server comes with the markdrop CLI ({MCP_LOCAL_MIN_CLI} or later) and runs while Claude Code, Claude Desktop, Cursor or
            VS Code is open.
          </>
        }
        points={[
          { icon: "send", title: "Send and receive peer-to-peer share links,", text: "one recipient at a time. Closing the app ends the share." },
          { icon: "film", title: "Publish or replace files from disk,", text: "video and audio up to 2 GB, and the link stays the same on a replace." },
          { icon: "shield", title: "Refuses secrets:", text: "SSH keys, cloud credentials, .env files and keychains." },
        ]}
        actions={
          <More href={docs("localMcp")} cta="mcp_local_docs">
            Set up the local server
          </More>
        }
        visual={
          <LoopShot
            name="mcp-local"
            w={984}
            h={756}
            addr={<b>Your AI app</b>}
            tag="Markdrop (on this computer)"
            tagIcon="laptop"
            tagOn
            caption="A real markdrop mcp upload_file call, replayed in the neutral chat app (fictional data)."
            label="An AI app asked to publish ~/Movies/demo.mp4 calls the local server's upload_file: it checks the 108.2 MB file, uploads it with a progress bar, verifies it on the server and answers: Uploaded and published: markdrop.in/demo, version 1."
          />
        }
      />

      <Feature
        id="privacy"
        rev
        eyebrow="Permissions and privacy"
        title="You approve every app."
        lede="Markdrop shows which app is asking and what it will be able to do before it gets anything."
        points={[
          { icon: "key", title: "Its own token,", text: "valid only for this server. Never your Markdrop sign-in." },
          { icon: "settings", title: "Disconnect any time", text: "in Settings › Connected apps. Its access ends at once; what it published stays yours." },
          { icon: "lock", title: "No way past a lock:", text: "no encrypted or password-protected documents, no getting past a workspace's sign-in." },
          { icon: "history", title: "Logs, not content:", text: "which tool ran, when and whether it worked, kept 90 days." },
        ]}
        actions={
          <More href={docs("connectedApps")} cta="mcp_privacy_docs">
            Connected apps
          </More>
        }
        visual={
          <LoopShot
            name="mcp-consent"
            w={624}
            h={840}
            addr={
              <>
                <b>markdrop.in</b>/oauth
              </>
            }
            caption="Markdrop's approval screen, recorded with fictional data."
            label="Markdrop's approval screen: AI app wants to access your Markdrop account, signed in as riya@acme.com; it will be able to read your documents, and publish and change documents; it can't read end-to-end encrypted documents and never sees your sign-in code. Approve, and: Approved. AI app is connected."
          />
        }
      />

      <Feature
        id="faq"
        even
        eyebrow="Questions"
        title="Before you connect."
        lede="Anything else, write to us."
        extra={
          <div className={m.help}>
            <ButtonLink href="/settings/connections" variant="secondary" iconLeft="sparkle" data-cta="mcp_manage">
              Manage connected apps
            </ButtonLink>
            <a className={m.mail} href="mailto:himanshu@markdrop.in">
              himanshu@markdrop.in
            </a>
          </div>
        }
        visual={<FaqList items={FAQ} />}
      />
    </SnapPage>
  );
}
