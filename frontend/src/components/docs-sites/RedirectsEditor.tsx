"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Alert, Button, IconButton, Input } from "@/components/ui";
import { listPages, type Redirect } from "@/lib/docsSites";
import { plural } from "./format";
import useLeaveGuard from "./useLeaveGuard";

type Row = Redirect & { key: number };

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
const pageOf = (p: string) => {
  const x = trim(p.split("#")[0]!);
  return x === "/index.md" ? "/" : x.endsWith(".md") ? x.slice(0, -3) : x;
};
const OWN = new Set(["/", "/changelog", "/llms.txt", "/llms-full.txt", "/skill.md", "/changelog.rss", "/changelog.json", "/changelog.md", "/sitemap.xml", "/robots.txt", "/index.md"]);

/**
 * The same checks the API makes on save (backend/app/services/docs_site_redirects.py, which follow
 * docs-check's rules for redirects.json), so a row says what's wrong as it's typed.
 */
export function redirectProblem(r: Redirect, all: Redirect[], pages: Set<string> | null): string {
  const from = r.from.trim();
  const to = r.to.trim();
  if (!from && !to) return "";
  if (!from.startsWith("/") || from.startsWith("//")) return "Start the old address with /.";
  if (/[?#\s]/.test(from)) return "The old address is a plain path (no ?, # or spaces).";
  if (trim(from) === "/") return "The home page can't be redirected.";
  if (!to) return "Where should it go?";
  const external = /^https:\/\//i.test(to);
  if (!external && (!to.startsWith("/") || to.startsWith("//") || /\s/.test(to))) return "Send it to a page of this site (/new/page) or an https:// address.";
  if (!external && trim(to.split("#")[0]!) === trim(from)) return "It redirects to itself.";
  if (all.filter((x) => trim(x.from.trim()) === trim(from)).length > 1) return "This old address is listed twice.";
  if (pages?.has(pageOf(from))) return "That's a page of this site; the redirect would hide it.";
  if (OWN.has(trim(from)) || ["docs-assets", "mcp", "md", "og", "_next"].includes(trim(from).split("/")[1] ?? "")) return "That's one of the docs site's own addresses.";
  if (!external) {
    const sources = new Set(all.map((x) => trim(x.from.trim())));
    if (sources.has(pageOf(to)) || sources.has(trim(to.split("#")[0]!))) return "That address redirects again. Point it at the final page.";
    if (pages && !pages.has(pageOf(to)) && !OWN.has(pageOf(to)) && !to.startsWith("/changelog/") && !to.startsWith("/docs-assets/")) return `There's no page ${pageOf(to)}.`;
  }
  return "";
}

/**
 * Settings › Redirects: old addresses → their new pages, edited as rows and saved together (the
 * build writes them to redirects.json; readers get a permanent redirect). Admins only.
 */
export function RedirectsEditor({ siteId, value, locked, saving, onSave }: {
  siteId: string;
  value: Redirect[];
  locked: boolean;
  saving: boolean;
  onSave: (rows: Redirect[]) => Promise<boolean>;
}) {
  const uid = useId();
  const [rows, setRows] = useState<Row[]>(() => value.map((r, i) => ({ ...r, key: i })));
  const [pages, setPages] = useState<string[] | null>(null);
  const [next, setNext] = useState(value.length);

  useEffect(() => { setRows(value.map((r, i) => ({ ...r, key: i }))); setNext(value.length); }, [value]);
  useEffect(() => {
    listPages(siteId).then((r) => setPages(r.pages.map((p) => p.path).sort())).catch(() => setPages(null));
  }, [siteId]);

  const pageSet = useMemo(() => (pages ? new Set(pages) : null), [pages]);
  const filled = rows.filter((r) => r.from.trim() || r.to.trim());
  const problems = rows.map((r) => redirectProblem(r, filled, pageSet));
  const dirty = JSON.stringify(filled.map(({ from, to }) => ({ from: from.trim(), to: to.trim() }))) !== JSON.stringify(value.map(({ from, to }) => ({ from, to })));
  const bad = problems.some(Boolean);
  const leaveGuard = useLeaveGuard(dirty && !locked, "the redirects");

  const set = (key: number, patch: Partial<Redirect>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => { setRows((rs) => [...rs, { from: "", to: "", key: next }]); setNext((n) => n + 1); };

  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 && (
        <div className="flex flex-col gap-2" role="list" aria-label="Redirects">
          <div className="hidden grid-cols-[1fr_auto_1fr_auto] gap-2 text-caption text-text-muted sm:grid" aria-hidden>
            <span>Old address</span><span className="w-4" /><span>Goes to</span><span className="w-8" />
          </div>
          {rows.map((r, i) => (
            <div key={r.key} role="listitem" className="flex flex-col gap-1">
              <div className="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
                <Input
                  mono
                  size="sm"
                  aria-label={`Old address ${i + 1}`}
                  placeholder="/old/page"
                  value={r.from}
                  readOnly={locked}
                  invalid={!!problems[i]}
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(e) => set(r.key, { from: e.target.value })}
                  className="max-sm:col-span-2"
                />
                <span className="hidden text-text-muted sm:inline" aria-hidden>→</span>
                <Input
                  mono
                  size="sm"
                  aria-label={`Goes to ${i + 1}`}
                  placeholder="/new/page"
                  list={`${uid}-pages`}
                  value={r.to}
                  readOnly={locked}
                  invalid={!!problems[i]}
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(e) => set(r.key, { to: e.target.value })}
                />
                {!locked && <IconButton icon="trash" label={`Remove redirect ${i + 1}`} size="sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />}
              </div>
              {problems[i] && <p className="text-[12.5px] text-danger" role="status">{problems[i]}</p>}
            </div>
          ))}
          <datalist id={`${uid}-pages`}>{pages?.map((p) => <option key={p} value={p} />)}</datalist>
        </div>
      )}
      {!locked && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" iconLeft="plus" onClick={add}>Add a redirect</Button>
          {dirty && (
            <>
              <Button variant="primary" size="sm" loading={saving} disabled={bad} onClick={() => void onSave(filled.map(({ from, to }) => ({ from: from.trim(), to: to.trim() })))}>
                Save {plural(filled.length, "redirect")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRows(value.map((x, k) => ({ ...x, key: k })))}>Discard</Button>
            </>
          )}
        </div>
      )}
      {dirty && bad && <Alert tone="warning">Fix the rows marked in red to save.</Alert>}
      {leaveGuard}
    </div>
  );
}

export default RedirectsEditor;
