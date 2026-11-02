"use client";

/**
 * Page and section actions: the heading hover bar (# link · Copy section · Ask about this), the
 * split "Copy page ▾" button (its menu has Connect to AI: the docs' MCP server), the right rail's
 * action list, and the phone's bottom bar (the same menu behind "More").
 */
import { Button, Dropdown, Icon, IconButton, copyText, cx, useToast, type MenuEntry } from "@/components/ui";
import { mcpLinks, openAppLink } from "../mcpLinks";
import { useConnectAi } from "./ConnectAi";
import { OPEN_IN, openInHref, usePageCopy } from "./page";
import { askAboutPage, askAboutSection, openAsk } from "./ask/store";
import { useDocsSite } from "./site";

export function HeadingActions({ id, label }: { id: string; label: string }) {
  const { page, copySection } = usePageCopy();
  const { ai } = useDocsSite();
  const toasts = useToast();
  return (
    <span className="dx-hactions no-print" data-heading-actions="">
      <a
        href={`#${id}`}
        className="dx-hactions__btn dx-hactions__hash"
        aria-label={`Link to this section: ${label}`}
        title="Link to this section"
        onClick={() => {
          const url = `${page?.url ?? location.origin + location.pathname}#${id}`;
          void copyText(url).then((ok) => ok && toasts.success("Link to section copied"));
        }}
      >
        #
      </a>
      {page?.sections[id] && (
        <button type="button" className="dx-hactions__btn" onClick={() => copySection(id)} aria-label={`Copy section: ${label}`}>
          <Icon name="copy" />
          Copy section
        </button>
      )}
      {ai && (
        <button type="button" className="dx-hactions__btn" onClick={() => askAboutSection(id, label)} aria-label={`${ai.name} about this section: ${label}`}>
          <Icon name="zap" />
          Ask about this
        </button>
      )}
    </span>
  );
}

/**
 * The page's actions menu (the split button's ▾ and the phone's bottom bar): copy or view the page
 * as Markdown, open it in an assistant, then Connect to AI (the docs' MCP server: copy its URL, add
 * it to Cursor or VS Code, or the steps for Claude, ChatGPT and the rest, in a dialog) while the
 * site offers it (site.json `mcp.connect`), and Ask AI about this page.
 */
function usePageMenu(openConnect: () => void): MenuEntry[] | null {
  const { page, copyPage, copyWithPrereqs, copyForAssistant } = usePageCopy();
  const { ai, url, mcpName, mcpConnect } = useDocsSite();
  const toasts = useToast();
  if (!page) return null;
  const n = page.prereq?.count ?? 0;
  const mcp = mcpLinks(url || page.url, mcpName);
  return [
    { label: "Copy page", description: "As Markdown, ready for any assistant", icon: "copy", onClick: copyPage },
    ...(n
      ? [{ label: "Copy page with what it builds on", description: `Adds the ${n === 1 ? "page" : `${n} pages`} it assumes you’ve read`, icon: "archive", onClick: copyWithPrereqs }]
      : []),
    { label: "View as Markdown", description: "Opens the .md version", icon: "doc", href: page.mdUrl, external: true },
    ...OPEN_IN.map((o, i) => ({ label: o.label, description: o.hint, icon: "external", href: openInHref(o.base, page.mdUrl), external: true, separated: i === 0, onClick: copyForAssistant })),
    ...(mcpConnect
      ? [
          { header: <span className="dx-pagemenu__head">Connect to AI</span>, separated: true },
          {
            label: "Copy MCP server URL",
            description: "For any AI app that takes an MCP server",
            icon: "link",
            onClick: () => void copyText(mcp.server).then((ok) => (ok ? toasts.success("MCP server URL copied") : toasts.error(`Couldn't copy. The URL is ${mcp.server}`))),
          },
          // cursor:// and vscode: links: assigned rather than routed, so nothing tries to prefetch them.
          { label: "Add to Cursor", description: "Installs the docs as an MCP server in Cursor", icon: "code", onClick: () => openAppLink(mcp.cursor) },
          { label: "Add to VS Code", description: "Installs the docs as an MCP server for Copilot Chat", icon: "code", onClick: () => openAppLink(mcp.vscode) },
          { label: "Connect Claude, ChatGPT and more", description: "The steps for each app", icon: "sparkle", onClick: openConnect },
        ]
      : []),
    ...(ai ? [{ label: `${ai.name} about this page`, description: "Answers from these docs, with sources", icon: "zap", onClick: askAboutPage, separated: true }] : []),
  ];
}

/** The split button next to the title. */
export function CopyPageButton({ compact }: { compact?: boolean }) {
  const { copyPage } = usePageCopy();
  const connect = useConnectAi();
  const items = usePageMenu(connect.open);
  if (!items) return null;
  return (
    <div className={cx("dx-split", compact && "dx-split--compact")}>
      <button type="button" className="dx-split__main" onClick={copyPage}>
        <Icon name="copy" />
        Copy page
      </button>
      <Dropdown
        align="right"
        minWidth={300}
        aria-label="More ways to use this page"
        menuClassName="dx-pagemenu"
        trigger={
          <button type="button" className="dx-split__more" aria-label="More ways to use this page">
            <Icon name="chevronDown" />
          </button>
        }
        items={items}
      />
      {connect.dialog}
    </div>
  );
}

/** The right rail's list under the contents. */
export function RailActions() {
  const { page, copyPage, copyForAssistant } = usePageCopy();
  const { mcpConnect } = useDocsSite();
  const connect = useConnectAi();
  if (!page) return null;
  const open = OPEN_IN.slice(0, 2);
  return (
    <ul className="dx-railactions">
      <li>
        <button type="button" onClick={copyPage}>
          <Icon name="copy" />
          Copy page as Markdown
        </button>
      </li>
      <li>
        <a href={page.mdUrl} target="_blank" rel="noopener">
          <Icon name="doc" />
          View as Markdown
        </a>
      </li>
      {open.map((o) => (
        <li key={o.id}>
          <a href={openInHref(o.base, page.mdUrl)} target="_blank" rel="noopener noreferrer" onClick={copyForAssistant}>
            <Icon name="external" />
            {o.label}
          </a>
        </li>
      ))}
      {mcpConnect && (
        <li>
          <button type="button" onClick={connect.open} aria-haspopup="dialog">
            <Icon name="sparkle" />
            Connect to AI
          </button>
          {connect.dialog}
        </li>
      )}
      {page.editUrl && (
        <li>
          <a href={page.editUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="edit" />
            Suggest an edit
          </a>
        </li>
      )}
    </ul>
  );
}

/**
 * Phones: Copy page and Ask AI (when the site has it), pinned to the bottom, with the page's
 * actions menu (Connect to AI among them) behind "More".
 */
export function MobileBottomBar() {
  const { page, copyPage } = usePageCopy();
  const { ai } = useDocsSite();
  const connect = useConnectAi();
  const items = usePageMenu(connect.open);
  if (!page || !items) return null;
  return (
    <div className="dx-bottombar no-print">
      <Button variant="secondary" iconLeft="copy" onClick={copyPage} className="dx-bottombar__btn">
        Copy page
      </Button>
      {ai && (
        <Button variant="primary" iconLeft="zap" onClick={() => openAsk()} className="dx-bottombar__btn">
          {ai.name}
        </Button>
      )}
      <Dropdown
        align="right"
        placement="top"
        minWidth={280}
        aria-label="More ways to use this page"
        menuClassName="dx-pagemenu"
        className="dx-bottombar__more"
        trigger={<IconButton icon="more" label="More ways to use this page" variant="secondary" />}
        items={items.filter((e) => !("label" in e) || e.label !== "Copy page")}
      />
      {connect.dialog}
    </div>
  );
}
