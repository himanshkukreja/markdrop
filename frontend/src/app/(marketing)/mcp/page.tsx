import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ReadMore } from "@/components/ReadMore";
import { Anchor, Badge, Button, Icon, MarkdropMark } from "@/components/ui";
import { CommandBlock } from "@/components/kit/CommandBlock";
import { CLI_URL } from "@/components/shell/links";
import { CLI_INSTALL } from "@/lib/cli";
import {
  MCP_LOCAL_MIN_CLI,
  MCP_LOCAL_SERVER,
  MCP_LOCAL_TOOLS,
  MCP_SCOPES,
  MCP_SERVER_URL,
  MCP_TOOLS,
  type McpScope,
} from "@/lib/mcp";
import { ConnectTabs } from "./ConnectTabs";
import { LocalServerTabs } from "./LocalServerTabs";

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

const CONTAINER = "mx-auto w-full max-w-marketing px-4 sm:px-6";
const LINK = "md-focus rounded-sm font-semibold text-accent-text underline underline-offset-2 hover:text-accent-text-hover";

const PROMPTS: Array<{ text: string; tools: string[] }> = [
  { text: "Turn these meeting notes into a Markdrop doc and give me the link.", tools: ["publish_document"] },
  { text: "Build an HTML dashboard of this CSV and publish it.", tools: ["publish_page"] },
  { text: "Make my Q3 report private.", tools: ["list_documents", "set_access"] },
  { text: "How many people read my launch notes?", tools: ["list_documents", "get_document_stats"] },
  { text: "Is anyone downloading the files I shared?", tools: ["list_shares"] },
  { text: "Is this share link still working? markdrop.in/share/4f9a2c71e0", tools: ["get_share_status"] },
];

/** Where each kind of AI app runs decides what it can do with peer-to-peer shares. */
const P2P_SPLIT: Array<{ icon: string; where: string; apps: string; body: string; tools: string[] }> = [
  {
    icon: "globe",
    where: "In the cloud",
    apps: "claude.ai, the Claude apps on your phone, ChatGPT",
    body: "Connected with the server URL above. They can list your shares and check whether a share link is live, but they never see the files on your computer.",
    tools: ["list_shares", "get_share_status"],
  },
  {
    icon: "laptop",
    where: "On your computer",
    apps: "Claude Code, Claude Desktop, Cursor, VS Code",
    body: "Add Markdrop's local server, which comes with the markdrop CLI. Your assistant can then send files and folders as a share link, download links people send you, and publish or replace files on Markdrop straight from disk.",
    tools: MCP_LOCAL_TOOLS.map((t) => t.name),
  },
];

const P2P_SAFETY: Array<{ icon: string; body: ReactNode }> = [
  { icon: "link", body: <>Anything you share goes to whoever has the link. Send it only to people you mean to.</> },
  { icon: "shield", body: <>Your AI app asks you before each share, and the server refuses secret files such as SSH keys, cloud credentials and <code className="font-mono text-[0.875em]">.env</code> files.</> },
  { icon: "clock", body: <>A share stops when you close the AI app, or when you ask the assistant to stop it.</> },
];

const PRIVACY: Array<{ icon: string; body: ReactNode }> = [
  {
    icon: "shield",
    body: <>You approve each app on Markdrop. The app gets its own token for this server, never your sign-in code.</>,
  },
  {
    icon: "settings",
    body: (
      <>
        Disconnect an app anytime in{" "}
        <Anchor href="/settings/connections" className={LINK}>Settings → Connected apps</Anchor>. Its tokens are revoked at once.
      </>
    ),
  },
  {
    icon: "upload",
    body: <>Nothing is published unless the assistant calls a publish tool, and what it publishes is yours to edit, lock or delete.</>,
  },
  {
    icon: "link",
    body: <>New links open for anyone who has the link, like everything on Markdrop. Ask for private or a password and the assistant sets it.</>,
  },
  {
    icon: "lock",
    body: <>Assistants can&apos;t read end-to-end encrypted documents. Markdrop stores ciphertext it has no key for, and the key never reaches the server.</>,
  },
  {
    icon: "history",
    body: <>Markdrop logs which tool ran, when, and whether it worked, for 90 days. Never what was in it.</>,
  },
];

const FAQ: Array<{ q: string; a: ReactNode }> = [
  {
    q: "Do I need a Markdrop account?",
    a: <>Yes, a free one. The assistant publishes and reads as you, so it needs an account to act for. You can create one with just an email address when the app sends you to Markdrop.</>,
  },
  {
    q: "Does it cost anything?",
    a: <>No. Connecting an app and using the tools is free.</>,
  },
  {
    q: "Which AI apps work with it?",
    a: <>Any MCP app that connects to remote servers and signs in with OAuth: Claude, Claude Code, ChatGPT, Cursor, VS Code, Windsurf and others. The steps for each are above.</>,
  },
  {
    q: "Why can't I find Developer mode in ChatGPT?",
    a: <>ChatGPT adds custom MCP servers through Developer mode, which needs a Pro, Team, Enterprise or Edu plan.</>,
  },
  {
    q: "Is my data used to train AI models?",
    a: <>Markdrop doesn&apos;t train models and doesn&apos;t sell your data. What the assistant reads from Markdrop becomes part of your conversation with it, so your AI provider&apos;s own data policy applies to that conversation.</>,
  },
  {
    q: "Can the assistant open other people's documents?",
    a: <>Only what you could open with the link yourself: your own documents, and documents anyone with the link can read. It never gets past a password, private access or a workspace&apos;s sign-in.</>,
  },
  {
    q: "How do I disconnect an app?",
    a: <>Open <Anchor href="/settings/connections" className={LINK}>Settings → Connected apps</Anchor> and choose Disconnect. The app loses access straight away; what it published stays yours, with the same links.</>,
  },
];

/* ── Pieces ───────────────────────────────────────────────────────────── */

function SectionHead({ eyebrow, title, id, lead }: { eyebrow: string; title: ReactNode; id: string; lead?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-eyebrow uppercase text-text-muted">{eyebrow}</p>
      <h2 id={id} className="mt-2.5 text-[28px] leading-9 font-extrabold tracking-[-0.025em] text-balance text-text md:mt-3 md:text-[36px] md:leading-[44px]">
        {title}
      </h2>
      {lead && <p className="mt-3 max-w-[60ch] text-body-lg text-text-secondary">{lead}</p>}
    </div>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-code-inline-bg px-1.5 py-0.5 font-mono text-[0.875em] text-code-inline">{children}</code>;
}

function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="grid size-6 flex-none place-items-center rounded-full bg-accent-soft text-micro font-bold text-accent-text">
      {n}
    </span>
  );
}

function ToolRow({ name, title, description, icon }: { name: string; title: string; description: string; icon: string }) {
  return (
    <li className="flex min-w-0 gap-3.5 px-5 py-4">
      <span className="grid size-9 flex-none place-items-center rounded-lg bg-surface-inset text-accent-text" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <div className="min-w-0">
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-body-strong text-text">{title}</span>
          <code className="font-mono text-caption text-text-muted">{name}</code>
        </p>
        <p className="m-0 mt-1 text-body text-text-secondary">{description}</p>
      </div>
    </li>
  );
}

function ScopeBadge({ scope }: { scope: McpScope }) {
  return (
    <Badge tone={scope === "documents:write" ? "info" : "neutral"} size="sm" className="font-mono">
      {scope}
    </Badge>
  );
}

/** The hero's chat: one image to assistive tech, never a tab stop. */
function ChatIllustration() {
  return (
    <div
      role="img"
      aria-label="A chat: you ask the assistant to turn meeting notes into a Markdrop doc; it runs Markdrop's publish_document tool and replies with a markdrop.in link"
      className="min-w-0"
    >
      <div inert className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-(--shadow-sm) sm:p-5">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <span className="grid size-6 place-items-center rounded-md bg-surface-active text-text-secondary"><Icon name="sparkle" size={14} /></span>
          <span className="text-body-strong text-text">Your AI assistant</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-caption text-text-muted">
            <span className="size-1.5 rounded-full bg-success" /> Markdrop connected
          </span>
        </div>

        <div className="ml-8 self-end rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2.5 text-body text-text">
          Turn these meeting notes into a Markdrop doc and give me the link.
        </div>

        <div className="flex min-w-0 items-center gap-2 self-start rounded-lg border border-border bg-surface-inset px-3 py-2 text-caption text-text-secondary">
          <MarkdropMark size={16} />
          <span className="truncate font-mono">publish_document</span>
          <span className="inline-flex flex-none items-center gap-1 text-success"><Icon name="check" size={12} /> Done</span>
        </div>

        <div className="mr-6 flex min-w-0 flex-col gap-2.5 self-start rounded-xl rounded-bl-sm bg-surface-inset px-3.5 py-3 text-body text-text">
          <span>Published. Anyone with the link can read it:</span>
          <span className="inline-flex min-w-0 items-center gap-2 self-start rounded-full border border-border bg-surface px-3 py-1">
            <Icon name="link" size={13} className="flex-none text-accent-text" />
            <span className="truncate font-mono text-caption text-accent-text">markdrop.in/q3-planning</span>
          </span>
          <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface p-3">
            <span className="text-body-strong text-text">Q3 planning notes</span>
            <span className="h-1.5 w-11/12 rounded-full bg-surface-active" />
            <span className="h-1.5 w-4/5 rounded-full bg-surface-active" />
            <span className="h-1.5 w-2/3 rounded-full bg-surface-active" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */

/** /mcp: what Markdrop's MCP server does and how to connect an AI app to it. Static. */
export default function McpPage() {
  const write = MCP_TOOLS.filter((t) => t.scope === "documents:write");
  const read = MCP_TOOLS.filter((t) => t.scope === "documents:read");

  return (
    <>
      {/* Hero */}
      <section aria-labelledby="mcp-title" className="pt-10 pb-16 md:pt-16 md:pb-24">
        <div className={`${CONTAINER} grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:gap-16`}>
          <div className="min-w-0">
            <p className="text-eyebrow uppercase text-text-muted">MCP server</p>
            <h1 id="mcp-title" className="mt-3 text-[40px] leading-[44px] font-extrabold tracking-[-0.03em] text-balance text-text md:text-display">
              Markdrop for AI assistants
            </h1>
            <p className="mt-5 max-w-[52ch] text-body-lg text-text-secondary md:text-lg md:leading-7">
              Publish what your AI writes as a link that renders, and read and update your documents from Claude, ChatGPT and more.
            </p>
            <div className="mt-8 max-w-[520px]">
              <CommandBlock command={MCP_SERVER_URL} prompt="" label="Server URL" copyLabel="Copy server URL" />
              <p className="mt-3 flex items-start gap-2 text-caption text-text-muted">
                <Icon name="info" size={14} className="mt-px flex-none" />
                <span>Paste it into your AI app, then sign in to Markdrop and approve. Free with a Markdrop account.</span>
              </p>
            </div>
          </div>
          <ChatIllustration />
        </div>
      </section>

      {/* Connect */}
      <section aria-labelledby="connect-title" className="border-y border-border bg-surface-inset py-16 md:py-24">
        <div className={`${CONTAINER} grid gap-8 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-16`}>
          <SectionHead
            eyebrow="Set up"
            id="connect-title"
            title="Connect your app"
            lead={<>One URL, then a sign-in on Markdrop. Pick your app for the exact steps. <ReadMore topic="connectAiApp">Full guide</ReadMore></>}
          />
          <ConnectTabs />
        </div>
      </section>

      {/* Tools */}
      <section aria-labelledby="tools-title" className="py-16 md:py-24">
        <div className={CONTAINER}>
          <SectionHead
            eyebrow="Tools"
            id="tools-title"
            title="What it can do"
            lead="Nineteen tools, each needing one of two permissions. Your assistant picks the right one from what you ask."
          />
          <div className="mt-10 grid min-w-0 gap-6 lg:grid-cols-2">
            {[
              { title: "Publish and manage", scope: "documents:write" as const, tools: write },
              { title: "Read and find", scope: "documents:read" as const, tools: read },
            ].map((g) => (
              <div key={g.scope} className="min-w-0 rounded-2xl border border-border bg-surface">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
                  <h3 className="m-0 text-h4 text-text">{g.title}</h3>
                  <ScopeBadge scope={g.scope} />
                </div>
                <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
                  {g.tools.map((t) => (
                    <ToolRow key={t.name} name={t.name} title={t.title} description={t.description} icon={t.icon} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Peer-to-peer: the local server */}
      <section id="p2p" aria-labelledby="p2p-title" className="border-y border-border bg-surface-inset py-16 md:py-24">
        <div className={CONTAINER}>
          <SectionHead
            eyebrow="On your computer"
            id="p2p-title"
            title="Send, receive and publish files from your computer"
            lead="Markdrop's peer-to-peer sharing sends files straight from your computer to the other person's, never through Markdrop's servers. So only an assistant running on your computer can send them, and the same goes for uploading a big file such as a 4K video: it reads it from disk and keeps the link when it replaces one."
          />

          <ul className="m-0 mt-10 grid list-none gap-4 p-0 md:grid-cols-2">
            {P2P_SPLIT.map((s) => (
              <li key={s.where} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-9 flex-none place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden="true">
                    <Icon name={s.icon} size={18} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="m-0 text-h4 text-text">{s.where}</h3>
                    <p className="m-0 text-caption text-text-muted">{s.apps}</p>
                  </div>
                </div>
                <p className="m-0 text-body text-text-secondary">{s.body}</p>
                <p className="m-0 mt-auto flex flex-wrap items-center gap-1.5 text-caption text-text-muted">
                  <span>Tools</span>
                  {s.tools.map((t) => (
                    <code key={t} className="rounded-sm bg-code-inline-bg px-1.5 py-0.5 font-mono text-code-inline">{t}</code>
                  ))}
                </p>
              </li>
            ))}
          </ul>

          <div className="mt-12 grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-16">
            {/* Setup */}
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h3 className="m-0 text-h3 text-text">Set up the local server</h3>
                <ReadMore topic="localMcp" className="text-body">Full guide</ReadMore>
              </div>
              <ol className="m-0 mt-6 flex list-none flex-col gap-8 p-0">
                <li className="flex min-w-0 gap-3">
                  <StepNumber n={1} />
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <p className="m-0 text-body text-text-secondary">
                      <span className="text-body-strong text-text">Install the markdrop CLI</span>, version {MCP_LOCAL_MIN_CLI} or later. Already have
                      it? Check with <InlineCode>markdrop --version</InlineCode>, and see the{" "}
                      <a href={CLI_URL} target="_blank" rel="noopener noreferrer" className={LINK}>CLI guide</a> for apt, dnf and Scoop.
                    </p>
                    {CLI_INSTALL.map(({ os, cmd }) => (
                      <CommandBlock key={os} label={os} command={cmd} />
                    ))}
                  </div>
                </li>
                <li className="flex min-w-0 gap-3">
                  <StepNumber n={2} />
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <p className="m-0 text-body text-text-secondary">
                      <span className="text-body-strong text-text">Add it to your AI app</span> as <InlineCode>{MCP_LOCAL_SERVER}</InlineCode>. It runs on your
                      computer while the app is open.
                    </p>
                    <LocalServerTabs />
                  </div>
                </li>
                <li className="flex min-w-0 gap-3">
                  <StepNumber n={3} />
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <p className="m-0 text-body text-text-secondary">
                      <span className="text-body-strong text-text">Add your API token</span>. Publishing and replacing files need it,
                      and it links your shares to your account so they show up in{" "}
                      <InlineCode>list_shares</InlineCode>. Sharing alone works without it. Create a token in{" "}
                      <Anchor href="/settings/tokens" className={LINK}>Settings → API tokens</Anchor> and add it to the server&apos;s entry
                      as <InlineCode>MARKDROP_TOKEN</InlineCode>:
                    </p>
                    <CommandBlock command={`"env": { "MARKDROP_TOKEN": "mdk_your_token" }`} prompt="" label="In the JSON config" copyLabel="Copy JSON" wrap />
                    <p className="m-0 text-caption text-text-muted">
                      In Claude Code, add <InlineCode>-e MARKDROP_TOKEN=mdk_your_token</InlineCode> before the <InlineCode>--</InlineCode>.
                    </p>
                  </div>
                </li>
              </ol>
            </div>

            {/* Local tools and safety */}
            <div className="flex min-w-0 flex-col gap-6">
              <div className="min-w-0 rounded-2xl border border-border bg-surface">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
                  <h3 className="m-0 text-h4 text-text">Tools on your computer</h3>
                  <Badge tone="neutral" size="sm" className="font-mono">{MCP_LOCAL_SERVER}</Badge>
                </div>
                <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
                  {MCP_LOCAL_TOOLS.map((t) => (
                    <ToolRow key={t.name} name={t.name} title={t.title} description={t.description} icon={t.icon} />
                  ))}
                </ul>
              </div>
              <div className="min-w-0">
                <h3 className="m-0 text-h4 text-text">Before you share</h3>
                <ul className="m-0 mt-4 flex list-none flex-col gap-4 p-0">
                  {P2P_SAFETY.map((p) => (
                    <li key={p.icon} className="flex min-w-0 gap-3 text-body text-text-secondary">
                      <Icon name={p.icon} size={18} className="mt-0.5 flex-none text-text-muted" />
                      <span className="min-w-0">{p.body}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Prompts */}
      <section aria-labelledby="prompts-title" className="py-16 md:py-24">
        <div className={CONTAINER}>
          <SectionHead eyebrow="Try it" id="prompts-title" title="Things to ask" lead="Say it the way you would to a colleague. These work once Markdrop is connected." />
          <ul className="m-0 mt-10 grid list-none gap-4 p-0 sm:grid-cols-2">
            {PROMPTS.map((p) => (
              <li key={p.text} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
                <p className="m-0 flex gap-3 text-body-lg text-text">
                  <Icon name="message" size={18} className="mt-1 flex-none text-accent-text" />
                  <span>&ldquo;{p.text}&rdquo;</span>
                </p>
                <p className="m-0 mt-auto flex flex-wrap items-center gap-1.5 text-caption text-text-muted">
                  <span>Uses</span>
                  {p.tools.map((t) => (
                    <code key={t} className="rounded-sm bg-code-inline-bg px-1.5 py-0.5 font-mono text-code-inline">{t}</code>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Permissions and privacy */}
      <section aria-labelledby="privacy-title" className="border-y border-border bg-surface-inset py-16 md:py-24">
        <div className={`${CONTAINER} grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16`}>
          <div className="min-w-0">
            <SectionHead
              eyebrow="Permissions and privacy"
              id="privacy-title"
              title="You choose what it can do"
              lead="When you connect an app, Markdrop shows exactly what it's asking for. These are the only two permissions."
            />
            <ul className="m-0 mt-8 flex list-none flex-col gap-3 p-0">
              {MCP_SCOPES.map((s) => (
                <li key={s.name} className="flex min-w-0 items-start gap-3.5 rounded-xl border border-border bg-surface p-4">
                  <span className="grid size-9 flex-none place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden="true">
                    <Icon name={s.icon} size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="m-0 text-body-strong text-text">{s.title}</p>
                    <p className="m-0 mt-0.5 text-body text-text-secondary">{s.description}</p>
                    <code className="mt-1.5 inline-block font-mono text-caption text-text-muted">{s.name}</code>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <ul className="m-0 flex min-w-0 list-none flex-col gap-4 self-end p-0">
            {PRIVACY.map((p, i) => (
              <li key={i} className="flex min-w-0 gap-3 text-body text-text-secondary">
                <Icon name={p.icon} size={18} className="mt-0.5 flex-none text-text-muted" />
                <span className="min-w-0">{p.body}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* FAQ */}
      <section aria-labelledby="faq-title" className="py-16 md:py-24">
        <div className={`${CONTAINER} grid gap-8 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-16`}>
          <div className="min-w-0">
            <SectionHead eyebrow="FAQ" id="faq-title" title="Questions" />
            <div className="mt-6 flex flex-col items-start gap-3">
              <Button variant="secondary" href="/settings/connections" iconLeft="sparkle">Manage connected apps</Button>
              <p className="m-0 text-caption text-text-muted">
                Something else? Write to{" "}
                <a href="mailto:himanshu@markdrop.in" className="md-focus rounded-sm font-mono text-text-secondary underline-offset-2 hover:underline">himanshu@markdrop.in</a>
              </p>
            </div>
          </div>
          <div className="min-w-0 divide-y divide-border rounded-2xl border border-border bg-surface">
            {FAQ.map((f) => (
              <details key={f.q} className="group min-w-0 px-5">
                <summary className="md-focus flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-3 text-body-strong text-text [&::-webkit-details-marker]:hidden">
                  <span>{f.q}</span>
                  <Icon name="chevronDown" size={16} className="flex-none text-text-muted transition-transform duration-(--duration-fast) group-open:rotate-180 motion-reduce:transition-none" />
                </summary>
                <p className="m-0 pb-4 text-body text-text-secondary">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
