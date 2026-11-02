"use client";

/**
 * Connect to AI: the docs' MCP server (`<docs origin>/mcp`) for a reader's own AI tools. Its URL
 * with Copy, one-click installs for Cursor and VS Code, and the steps for Claude, Claude Code,
 * ChatGPT and any other MCP app. Opened from the page actions menu, the right rail and the phone's
 * bottom bar (PageActions.tsx); offered while site.json `mcp.connect` isn't false.
 */
import { useState } from "react";
import { Button, CopyButton, Dialog, Icon } from "@/components/ui";
import { CLAUDE_CONNECTORS_URL, mcpLinks, openAppLink } from "../mcpLinks";
import { useDocsSite } from "./site";

export function ConnectAiDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { url, name, mcpName } = useDocsSite();
  const site = url || (typeof window !== "undefined" ? window.location.origin : "");
  const links = mcpLinks(site, mcpName);
  const docs = name ? `the ${name} docs` : "these docs";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect to AI"
      description={`Add ${docs} to your AI tools. They search and read the pages while they help you, through the docs' MCP server.`}
      bodyClassName="dx-connect"
    >
      <div className="dx-connect__server">
        <span className="dx-connect__label" id="dx-connect-url">MCP server URL</span>
        <div className="dx-connect__row">
          <code className="dx-connect__url ph-no-capture" aria-labelledby="dx-connect-url">{links.server}</code>
          <CopyButton text={links.server} label="Copy URL" copiedLabel="Copied" announceText="MCP server URL copied" />
        </div>
        <p className="dx-connect__note">No sign-in or API key. It reads the public pages only.</p>
      </div>

      <div className="dx-connect__installs">
        <Button variant="secondary" iconLeft="code" onClick={() => openAppLink(links.cursor)}>
          Add to Cursor
        </Button>
        <Button variant="secondary" iconLeft="code" onClick={() => openAppLink(links.vscode)}>
          Add to VS Code
        </Button>
      </div>

      <ul className="dx-connect__apps">
        <li>
          <strong>Claude</strong>
          <span>
            In Claude on the web or desktop: Settings › Connectors › <em>Add custom connector</em>, then paste the URL. The Free plan allows one custom connector.{" "}
            <a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noopener noreferrer">
              Open Claude’s connectors
              <Icon name="arrowUpRight" />
              <span className="md-visually-hidden"> (opens in a new tab)</span>
            </a>
          </span>
        </li>
        <li>
          <strong>Claude Code</strong>
          <span className="dx-connect__row">
            <code className="dx-connect__cmd">{links.claudeCode}</code>
            <CopyButton text={links.claudeCode} label="Copy command" iconOnly announceText="Command copied" />
          </span>
        </li>
        <li>
          <strong>ChatGPT</strong>
          <span>
            With developer mode, on the web (Plus, Pro, Business, Enterprise and Edu plans): Settings › Apps › Advanced settings › <em>Developer mode</em>, then create an app with the URL and no authentication.
          </span>
        </li>
        <li>
          <strong>Other apps</strong>
          <span>Any app that connects to remote MCP servers (Streamable HTTP) can use the URL.</span>
        </li>
      </ul>
    </Dialog>
  );
}

/** A "Connect to AI" opener and its dialog, for one place on the page. */
export function useConnectAi(): { open: () => void; dialog: React.ReactNode } {
  const [isOpen, setOpen] = useState(false);
  return { open: () => setOpen(true), dialog: <ConnectAiDialog open={isOpen} onClose={() => setOpen(false)} /> };
}
