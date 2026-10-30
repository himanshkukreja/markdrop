"use client";

/**
 * Page and section actions: the heading hover bar (# link · Copy section · Ask about this), the
 * split "Copy page ▾" button, the right rail's action list, and the phone's bottom bar.
 */
import { Button, Dropdown, Icon, copyText, cx, useToast, type MenuEntry } from "@/components/ui";
import { OPEN_IN, mcpInstallLinks, openInHref, usePageCopy } from "./page";
import { askAboutPage, askAboutSection, openAsk } from "./ask/store";

export function HeadingActions({ id, label }: { id: string; label: string }) {
  const { page, copySection } = usePageCopy();
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
      <button type="button" className="dx-hactions__btn" onClick={() => askAboutSection(id, label)} aria-label={`Ask AI about this section: ${label}`}>
        <Icon name="zap" />
        Ask about this
      </button>
    </span>
  );
}

/** The split button next to the title. */
export function CopyPageButton({ compact }: { compact?: boolean }) {
  const { page, copyPage, copyWithPrereqs, copyForAssistant } = usePageCopy();
  if (!page) return null;
  const n = page.prereq?.count ?? 0;
  const mcp = mcpInstallLinks(page.url);
  const items: MenuEntry[] = [
    { label: "Copy page", description: "As Markdown, ready for any assistant", icon: "copy", onClick: copyPage },
    ...(n
      ? [{ label: "Copy page with what it builds on", description: `Adds the ${n === 1 ? "page" : `${n} pages`} it assumes you’ve read`, icon: "archive", onClick: copyWithPrereqs }]
      : []),
    { label: "View as Markdown", description: "Opens the .md version", icon: "doc", href: page.mdUrl, external: true },
    ...OPEN_IN.map((o, i) => ({ label: o.label, description: o.hint, icon: "external", href: openInHref(o.base, page.mdUrl), external: true, separated: i === 0, onClick: copyForAssistant })),
    {
      label: "Add docs to Cursor",
      description: "Installs the docs MCP server, so Cursor can search these docs",
      icon: "code",
      separated: true,
      // A cursor:// link: assigned rather than routed, so nothing tries to prefetch it.
      onClick: () => window.location.assign(mcp.cursor),
    },
    { label: "Add docs to VS Code", description: "Installs the docs MCP server for Copilot Chat", icon: "code", href: mcp.vscode, external: true },
    { label: "Ask AI about this page", description: "Answers from these docs, with sources", icon: "zap", onClick: askAboutPage, separated: true },
  ];
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
    </div>
  );
}

/** The right rail's list under the contents. */
export function RailActions() {
  const { page, copyPage, copyForAssistant } = usePageCopy();
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

/** Phones: Copy page and Ask AI, pinned to the bottom. */
export function MobileBottomBar() {
  const { page, copyPage } = usePageCopy();
  if (!page) return null;
  return (
    <div className="dx-bottombar no-print">
      <Button variant="secondary" iconLeft="copy" onClick={copyPage} className="dx-bottombar__btn">
        Copy page
      </Button>
      <Button variant="primary" iconLeft="zap" onClick={() => openAsk()} className="dx-bottombar__btn">
        Ask AI
      </Button>
    </div>
  );
}
