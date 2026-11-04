"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, Avatar, Button, ConfirmDialog, Drawer, Field, Icon, Input, Skeleton, Switch, Textarea, cx } from "@/components/ui";
import { IconPicker } from "@/components/docs-editor/views/shared";
import { docsErrorMessage, getVersion, listVersions, type Page, type PageVersion } from "@/lib/docsSites";
import { firstName, timeAgo, whenShort } from "../format";
import type { Check, OutlineItem } from "./pageChecks";
import { pathProblem, type PageFields } from "./usePageSession";
import { PageAccess, type PageAccessInfo } from "./PageAccess";

export type PanelTab = "checks" | "page" | "comments" | "history";

const DESCRIPTION_MAX = 160;

function versionLabel(v: PageVersion): string {
  if (v.kind === "import") return "Imported";
  if (v.kind === "restore") return "Restored an earlier version";
  return "Edited";
}

const CHECK_ICON: Record<Check["kind"], string> = {
  link_missing: "link",
  link_unpublished: "link",
  image_alt: "image",
  heading_empty: "heading",
  heading_duplicate: "hash",
  page_long: "lines",
  ok: "checkCircle",
};

/** A text-style action in a check row ("Show", "Fix"). */
function RowAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="md-focus shrink-0 rounded px-1 text-[12px] font-semibold text-accent-text hover:underline">
      {children}
    </button>
  );
}

/** The Checks tab: each problem with Show / Fix, a "looks good" row, then "On this page". */
function ChecksTab({ checks, onShow, onFix, readOnly, outline, active, onOutline, mode }: {
  checks: Check[];
  onShow: (c: Check) => void;
  onFix: (c: Check) => void;
  readOnly: boolean;
  outline: OutlineItem[];
  active: number;
  onOutline: (i: number) => void;
  mode: "visual" | "markdown";
}) {
  return (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col gap-0.5" aria-label="Checks">
        {checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2.5 rounded-md px-2 py-2.5">
            <span className={cx("mt-px inline-flex shrink-0", c.kind === "ok" ? "text-success" : "text-warning")}><Icon name={CHECK_ICON[c.kind]} size={15} /></span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-text">{c.title}</span>
              {/* Link text and titles are the customer's words. */}
              <span className="ph-no-capture text-[12px] leading-4 text-text-muted">{c.note}</span>
              {(c.target || (c.fix && !readOnly)) && (
                <span className="-ml-1 flex items-center gap-2 pt-1">
                  {c.target && <RowAction onClick={() => onShow(c)}>Show</RowAction>}
                  {c.fix && !readOnly && <RowAction onClick={() => onFix(c)}>{c.fix.kind === "create_page" ? "Create the page" : c.fix.kind === "image_alt" ? "Add a description" : "Remove them"}</RowAction>}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col">
        <h3 className="px-2 pb-1.5 text-[12px] font-semibold text-text-muted">On this page</h3>
        {outline.length === 0 ? (
          <p className="px-2 text-[12px] text-text-muted">Headings (## and ###) show here as you add them.</p>
        ) : (
          <ol className="ph-no-capture flex flex-col" aria-label="On this page">
            {outline.map((o, i) => (
              <li key={`${o.text}-${o.nth}-${i}`}>
                <button
                  type="button"
                  onClick={() => onOutline(i)}
                  aria-current={i === active ? "location" : undefined}
                  className={cx(
                    "md-focus block w-full truncate border-l-2 py-[5px] pr-2 text-left text-[13px] transition-colors pointer-coarse:py-3",
                    o.level === 2 ? "pl-2.5" : "pl-[22px]",
                    i === active && mode === "visual" ? "border-accent text-text" : "border-border text-text-secondary hover:text-text",
                  )}
                  title={o.text}
                >
                  {o.text}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** The Page tab: address, icon, description (meta description and llms.txt), "Show in the sidebar". */
function PageTab({ fields, readOnly, isHome, onChange, origin, access }: { fields: PageFields; readOnly: boolean; isHome: boolean; onChange: (patch: Partial<PageFields>) => void; origin?: string | null; access?: PageAccessInfo }) {
  const uid = useId();
  const bad = pathProblem(fields.path);
  const over = fields.description.length > DESCRIPTION_MAX;
  return (
    <div className="flex flex-col gap-4">
      {origin && (
        <p className="flex min-w-0 items-start gap-2 rounded-md bg-surface-inset px-2.5 py-2 text-[12px] text-text-secondary">
          <Icon name="github" size={13} className="mt-px shrink-0" />
          <span className="min-w-0">From GitHub: <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{origin}</code>. Its title, description and icon come from the file too.</span>
        </p>
      )}
      <Field label="Address" htmlFor={`${uid}-path`} error={bad || undefined} hint={isHome ? "The home page is always /." : "Change it and the old address redirects to the new one (Settings › Redirects)."}>
        <Input id={`${uid}-path`} className="ph-no-capture" mono size="sm" value={fields.path} readOnly={readOnly || isHome} spellCheck={false} autoCapitalize="none" onChange={(e) => onChange({ path: e.target.value.toLowerCase() })} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-text" id={`${uid}-icon`}>Icon</span>
        <div className="flex items-center gap-3" aria-labelledby={`${uid}-icon`}>
          <IconPicker value={fields.icon} size="sm" label="Page icon" readOnly={readOnly} onChange={(icon) => onChange({ icon })} />
          <span className="text-[12px] text-text-muted">{fields.icon ? "Shown beside the page in the sidebar." : "No icon: the sidebar shows a page."}</span>
          {fields.icon && !readOnly && (
            <button type="button" className="md-focus ml-auto rounded text-[12px] font-semibold text-text-muted hover:text-text" onClick={() => onChange({ icon: null })}>Remove</button>
          )}
        </div>
      </div>
      <Field
        label="Description"
        htmlFor={`${uid}-desc`}
        hint={over ? undefined : `Under the title, in search results and link previews, and in the guide's llms.txt. ${fields.description.length}/${DESCRIPTION_MAX}`}
        error={over ? `${fields.description.length}/${DESCRIPTION_MAX} characters: search results cut it short.` : undefined}
      >
        <Textarea
          id={`${uid}-desc`}
          className="ph-no-capture"
          rows={3}
          value={fields.description}
          readOnly={readOnly}
          placeholder="One sentence on what this page helps with"
          onChange={(e) => onChange({ description: e.target.value.replace(/\n/g, " ") })}
        />
      </Field>
      <Switch label="Show in the sidebar" checked={!fields.hidden} disabled={readOnly || isHome} onChange={(e) => onChange({ hidden: !e.target.checked })} />
      {access && (
        <PageAccess
          value={typeof fields.frontmatter_extra?.access === "string" ? (fields.frontmatter_extra.access as string) : null}
          info={access}
          readOnly={readOnly}
          isHome={isHome}
          onChange={(v) => onChange({ frontmatter_extra: { ...fields.frontmatter_extra, access: v ?? undefined } })}
        />
      )}
    </div>
  );
}

/** The History tab: every kept version, View (in a drawer) and Restore as a new draft. */
function HistoryTab({ page, title, readOnly, onRestore }: { page: Page; title: string; readOnly: boolean; onRestore: (rev: number) => Promise<void> }) {
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<PageVersion | null>(null);
  const [confirm, setConfirm] = useState<PageVersion | null>(null);

  const load = useCallback(async () => {
    try {
      setVersions(await listVersions(page.site_id, page.id));
      setError("");
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't load the history."));
    }
  }, [page.site_id, page.id]);
  // Reload when the page changes or a new version is saved (rev moves).
  useEffect(() => { void load(); }, [load, page.rev]);

  const view = async (v: PageVersion) => {
    setViewing(v);
    try {
      const full = await getVersion(page.site_id, page.id, v.rev);
      setViewing((cur) => (cur?.rev === v.rev ? full : cur));
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't open that version."));
      setViewing(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-text-muted">Every save is kept (the last 50). Restoring makes a new draft; nothing is lost.</p>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      {!versions && !error && <div className="flex flex-col gap-3 pt-2"><Skeleton width="80%" /><Skeleton width="70%" /><Skeleton width="75%" /></div>}
      {versions?.length === 0 && <p className="text-[13px] text-text-muted">No saved versions yet.</p>}
      <ol className="flex flex-col">
        {versions?.map((v, i) => (
          <li key={v.rev} className={cx("flex items-center gap-2.5 py-2.5", i > 0 && "border-t border-border")}>
            <Avatar name={v.by_name || "Someone"} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-text">{versionLabel(v)}{v.rev === page.rev ? " · current" : ""}</span>
              <span className="block truncate text-[12px] text-text-muted">{v.by_name || "Someone"} · {whenShort(v.at)}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => void view(v)}>View</Button>
          </li>
        ))}
      </ol>

      <Drawer
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `Version ${viewing.rev}` : "Version"}
        description={viewing ? `${versionLabel(viewing)} by ${viewing.by_name || "someone"}, ${whenShort(viewing.at)}` : undefined}
        width={520}
      >
        {viewing && (
          <div className="ph-no-capture flex flex-col gap-3">
            {!readOnly && viewing.rev !== page.rev && (
              <div><Button variant="primary" size="sm" iconLeft="rotate" onClick={() => setConfirm(viewing)}>Restore this version</Button></div>
            )}
            <p className="text-body-strong text-text">{viewing.title}</p>
            {viewing.description && <p className="text-[13px] text-text-secondary">{viewing.description}</p>}
            {viewing.markdown === undefined ? (
              <Skeleton variant="rect" height={160} />
            ) : (
              <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-inset p-3 font-mono text-[12.5px] leading-5 text-text">{viewing.markdown}</pre>
            )}
            {readOnly && <Alert tone="neutral">You can look at earlier versions; restoring one needs the page free to edit.</Alert>}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        tone="default"
        title="Restore this version?"
        body={<>It becomes the newest draft of “<span className="ph-sensitive ph-mask">{title}</span>”. The current draft stays in the history, and readers see nothing until you publish.</>}
        confirmLabel="Restore"
        onConfirm={async () => {
          if (!confirm) return;
          await onRestore(confirm.rev);
          setConfirm(null);
          setViewing(null);
        }}
      />
    </div>
  );
}

export interface PanelFooter {
  editedBy: string | null;
  editedAt: string | null;
  /** Other people editing pages of this guide right now (page locks). */
  editing: Array<{ name: string; title: string; here: boolean }>;
}

/**
 * The editor's right panel: Checks (with "On this page"), Page (address, icon, description,
 * sidebar), Comments and History, and under them who last edited the page and who else is editing
 * what right now.
 */
export function EditorPanel({
  tab, onTab, page, fields, readOnly, isHome, onChange, onRestore,
  checks, onShow, onFix, outline, activeHeading, onOutline, mode,
  comments, commentCount, footer, access,
}: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  page: Page;
  fields: PageFields;
  readOnly: boolean;
  isHome: boolean;
  onChange: (patch: Partial<PageFields>) => void;
  onRestore: (rev: number) => Promise<void>;
  checks: Check[];
  onShow: (c: Check) => void;
  onFix: (c: Check) => void;
  outline: OutlineItem[];
  activeHeading: number;
  onOutline: (i: number) => void;
  mode: "visual" | "markdown";
  /** The Comments tab's content (null: no comments for this role). */
  comments: React.ReactNode | null;
  commentCount: number;
  footer: PanelFooter;
  /** Private pages: the page's "Who can open this page" (PageAccess). */
  access?: PageAccessInfo;
}) {
  const problems = checks.filter((c) => c.kind !== "ok").length;
  const tabs: Array<{ id: PanelTab; label: string; count?: number; warn?: boolean }> = [
    { id: "checks", label: "Checks", count: problems || undefined, warn: true },
    { id: "page", label: "Page" },
    ...(comments ? [{ id: "comments" as const, label: "Comments", count: commentCount || undefined }] : []),
    { id: "history", label: "History" },
  ];
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const uid = useId();
  const current = tabs.some((t) => t.id === tab) ? tab : "checks";
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Page panel" className="flex shrink-0 gap-0 border-b border-border px-2">
        {tabs.map((t, i) => {
          const on = t.id === current;
          return (
            <button
              key={t.id}
              ref={(el) => { tabRefs.current[t.id] = el; }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${uid}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => onTab(t.id)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!;
                onTab(next.id);
                tabRefs.current[next.id]?.focus();
              }}
              className={cx(
                "md-focus -mb-px inline-flex h-[42px] items-center gap-1.5 border-b-2 px-2 text-[13px] font-semibold transition-colors pointer-coarse:h-11",
                on ? "border-text text-text" : "border-transparent text-text-muted hover:text-text",
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={cx("grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[12px] font-bold leading-none", t.warn ? "bg-warning-soft text-warning" : "bg-surface-inset text-text-secondary")}>
                  {t.count > 99 ? "99+" : t.count}
                  <span className="md-visually-hidden"> {t.warn ? "to look at" : "open"}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${current}`} className="min-h-0 flex-1 overflow-y-auto p-4">
        {current === "checks" && (
          <ChecksTab checks={checks} onShow={onShow} onFix={onFix} readOnly={readOnly} outline={outline} active={activeHeading} onOutline={onOutline} mode={mode} />
        )}
        {current === "page" && <PageTab fields={fields} readOnly={readOnly} isHome={isHome} onChange={onChange} origin={page.origin?.kind === "github" ? page.origin.path : null} access={access} />}
        {current === "comments" && comments}
        {current === "history" && <HistoryTab page={page} title={fields.title} readOnly={readOnly} onRestore={onRestore} />}
      </div>
      <div className="flex shrink-0 flex-col gap-1 border-t border-border px-4 py-3 text-[12px] text-text-muted">
        {footer.editedAt && (
          <span className="truncate">
            Last edited{footer.editedBy ? <> by <span className="ph-sensitive ph-mask">{firstName(footer.editedBy)}</span></> : null} · {timeAgo(footer.editedAt)}
          </span>
        )}
        {footer.editing.slice(0, 3).map((e) => (
          <span key={`${e.name}-${e.title}`} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", e.here ? "bg-success" : "bg-warning")} />
            <span className="min-w-0 truncate"><span className="ph-sensitive ph-mask">{firstName(e.name)}</span> is editing “<span className="ph-no-capture">{e.title}</span>”</span>
          </span>
        ))}
        {current !== "history" && (
          <button type="button" className="md-focus self-start rounded text-[12px] font-semibold text-accent-text hover:underline pointer-coarse:min-h-11" onClick={() => onTab("history")}>
            Version history
          </button>
        )}
      </div>
    </div>
  );
}

export default EditorPanel;
