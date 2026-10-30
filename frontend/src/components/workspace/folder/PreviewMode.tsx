"use client";

/**
 * Preview as (PreviewAs board): what a folder looks like to someone else, before sharing it.
 *
 * `/w/<ws>/f/<folder>?preview=anyone|member|email(&email=…)`: the state lives in the URL. The server
 * evaluates its own access rules for a stand-in reader (`GET /workspaces/{id}/preview`); this screen
 * only lays the answer out: what they'd see on the left, what's hidden from them and why on the
 * right. Nothing changes until the caller chooses; the one fix offered ("Let anyone open") is the
 * caller's own items only (`can_open_up`), behind a confirm.
 *
 * A full-screen mode over the app (a modal region: focus starts on its title and stays inside;
 * Escape or "Exit preview" leave it).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Alert, Badge, Button, ConfirmDialog, Icon, Input, SegmentedControl, Skeleton, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { relativeTime } from "@/components/dashboard/format";
import { setAccessLevel } from "@/lib/access";
import {
  errorStatus, getPreview, purgeDocument, type PreviewAs, type PreviewHidden, type PreviewResult,
} from "@/lib/workspaces";
import { workspaceChanged } from "@/lib/workspaceStore";
import { ItemTile } from "./ItemRow";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function reasonBadge(h: PreviewHidden, team: string): { label: string; icon: string } {
  switch (h.reason) {
    case "team": return { label: `${team} team`, icon: "user" };
    case "people": return { label: "People added", icon: "lock" };
    case "password": return { label: "Password", icon: "lock" };
    case "signin": return { label: "Sign-in needed", icon: "user" };
    default: return { label: "Empty for them", icon: "folder" };
  }
}

function hiddenLine(h: PreviewHidden): string {
  if (h.kind === "folder") return "Nothing in it is open to them";
  if (h.yours) return h.reason === "password" ? "Yours · password stays" : "Yours";
  return `${h.owner_name ? `${h.owner_name}’s` : "Someone else’s"} — ask them to share it`;
}

export default function PreviewMode({
  workspaceId, workspaceName, team, folderId, folderName, address, as, email, canEmail, onChangeAs, onExit,
}: {
  workspaceId: string;
  workspaceName: string;
  team: string;
  folderId: string | null;
  /** The folder's name, or the workspace's at the top level. */
  folderName: string;
  /** "docs.acme.com/guides" when the workspace has a live domain. */
  address: string | null;
  as: PreviewAs;
  email: string;
  /** Admins may preview as a particular person. */
  canEmail: boolean;
  onChangeAs: (as: PreviewAs, email?: string) => void;
  onExit: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [emailDraft, setEmailDraft] = useState(email);
  const [openUp, setOpenUp] = useState<PreviewHidden | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const load = useCallback(async () => {
    if (as === "email" && !email) { setData(null); setLoading(false); setError(""); return; }
    setLoading(true);
    setError("");
    try {
      setData(await getPreview(workspaceId, { folder: folderId, as, email }));
    } catch (e) {
      const s = errorStatus(e);
      setData(null);
      setError(
        s === 403 ? (as === "email" ? "Only admins can preview as a particular person." : "Only members can preview this workspace.")
          : s === 404 || s === 405 ? "Preview isn't available on this server yet."
            : e instanceof Error && e.message ? e.message : "Couldn't load the preview. Try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId, folderId, as, email]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => setEmailDraft(email), [email]);

  // A mode, not a page: lock the page behind it, start on its title, keep Tab inside, Esc leaves.
  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]:not([data-md-preview])')) return;
      e.preventDefault();
      onExit();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [mounted, onExit]);

  function trap(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !root.current) return;
    const f = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const options = [
    { value: "anyone" as PreviewAs, label: "Anyone with the link" },
    { value: "member" as PreviewAs, label: `${/^[aeiou]/i.test(team) ? "An" : "A"} ${team} member` },
    ...(canEmail ? [{ value: "email" as PreviewAs, label: "Someone by email…" }] : []),
  ];

  const visibleFolders = data?.visible.folders ?? [];
  const totalFolders = data?.counts.folders_total ?? visibleFolders.length + (data?.hidden.filter((h) => h.kind === "folder").length ?? 0);
  const shownFolders = data?.counts.folders_visible ?? visibleFolders.length;
  const summary = data
    ? <>They&apos;ll see <strong className="font-semibold text-text">{data.counts.visible} of {data.counts.total} items</strong>{totalFolders ? ` and ${shownFolders} of ${totalFolders} folders` : ""}.</>
    : null;

  if (!mounted) return null;
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby="md-preview-title"
      data-md-preview=""
      onKeyDown={trap}
      className="fixed inset-0 z-[90] overflow-y-auto bg-bg text-text"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-accent-soft px-4 py-3 sm:px-6">
        <span aria-hidden className="flex text-accent-text"><Icon name="eye" size={18} /></span>
        <h1 id="md-preview-title" ref={titleRef} tabIndex={-1} className="text-body-strong text-text outline-none">
          You&apos;re previewing {folderName} as
        </h1>
        <SegmentedControl<PreviewAs>
          aria-label="Preview as"
          size="sm"
          value={as}
          onChange={(v) => onChangeAs(v, v === "email" ? emailDraft : undefined)}
          options={options}
          className="max-w-full overflow-x-auto"
        />
        <span className="text-[13px] leading-5 text-text-secondary" role="status" aria-live="polite">{loading ? "Checking…" : summary}</span>
        <span className="ml-auto">
          <Button variant="secondary" size="sm" iconLeft="x" onClick={onExit}>Exit preview</Button>
        </span>
      </header>

      <div className="mx-auto flex max-w-[1280px] flex-wrap gap-6 px-4 pt-7 pb-10 sm:px-8">
        {as === "email" && (
          <form
            className="flex w-full min-w-0 flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (emailDraft.trim()) onChangeAs("email", emailDraft.trim()); }}
          >
            <div className="min-w-0 flex-[0_1_320px]">
              <Input
                type="email"
                aria-label="Their email address"
                placeholder="name@company.com"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary" disabled={!emailDraft.trim()}>Show what they see</Button>
            <span className="text-caption text-text-muted">Uses what they&apos;ve been given, by name or as a member.</span>
          </form>
        )}

        {error && <div className="w-full"><Alert tone="danger" title="Couldn't preview">{error}</Alert></div>}

        <section aria-labelledby="md-preview-see" className="min-w-0 flex-[999_1_560px] overflow-hidden rounded-2xl border border-border bg-surface">
          <h2 id="md-preview-see" className="md-visually-hidden">What they see</h2>
          <div className="flex items-center gap-2.5 border-b border-border bg-surface-inset px-4 py-2.5 font-mono text-caption text-text-muted">
            <Icon name="lock" size={14} className="shrink-0" />
            <span className="truncate">{address ?? "markdrop.in"}</span>
          </div>
          <div className="flex flex-col gap-4 px-5 py-6 sm:px-8 sm:py-7">
            <p className="text-[13px] text-text-muted">{folderId ? `${workspaceName} › ${folderName}` : workspaceName}</p>
            <p className="text-h1 text-text" aria-hidden>{folderName}</p>
            {loading && !data ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                {[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" height={60} />)}
              </div>
            ) : data && data.visible.items.length === 0 && visibleFolders.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-body text-text-secondary">
                Nothing here is open to them. They&apos;d see an empty folder.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="What they see">
                {visibleFolders.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3.5">
                    <span aria-hidden className="flex text-accent-text"><Icon name="folder" size={22} /></span>
                    <span className="flex min-w-0 flex-col">
                      <strong className="truncate text-body-strong text-text" dir="auto">{f.name}</strong>
                      {f.item_count != null && <span className="text-caption text-text-muted">{f.item_count === 1 ? "1 item" : `${f.item_count} items`}</span>}
                    </span>
                  </li>
                ))}
                {(data?.visible.items ?? []).map((it, i) => (
                  <li key={it.slug ?? `r${i}`} className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3">
                    <ItemTile file={{ slug: it.slug ?? "private", kind: it.kind, mime: it.mime }} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-body-strong text-text" dir="auto">{it.redacted ? "A private item" : it.title || it.slug}</span>
                      {it.updated_at && <span className="text-caption text-text-muted">Updated {relativeTime(it.updated_at)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside aria-labelledby="md-preview-hidden" className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 lg:max-w-[400px]">
          <h2 id="md-preview-hidden" className="text-h3 text-text">Hidden from them</h2>
          <p className="text-[13px] leading-5 text-text-secondary">
            Nothing changes until you choose. A shared folder never opens what&apos;s inside it by itself.{" "}
            <ReadMore topic="previewAs" />
          </p>
          {loading && !data ? (
            <Skeleton variant="rect" height={72} />
          ) : data && data.hidden.length === 0 ? (
            <p className="flex items-center gap-1.5 text-caption text-text-secondary">
              <Icon name="checkCircle" size={14} className="text-success" /> Nothing you can see is hidden from them.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {(data?.hidden ?? []).map((h, i) => {
                const why = reasonBadge(h, team);
                const title = h.title || (h.kind === "folder" ? "A folder" : "A private item");
                return (
                  <li key={h.slug ?? `h${i}`} className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3.5 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon name={h.kind === "folder" ? "folder" : h.kind === "artifact" ? "doc" : "lines"} size={14} className="shrink-0 text-text-secondary" />
                      <strong className="min-w-0 flex-1 truncate text-body-strong text-text" dir="auto">
                        {title}{h.kind === "folder" && h.title ? <span className="font-normal text-text-muted"> (folder)</span> : null}
                      </strong>
                      <Badge size="sm" icon={why.icon}>{why.label}</Badge>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-text-muted">
                      <span className="min-w-0 flex-1">{hiddenLine(h)}</span>
                      {h.can_open_up && h.slug && (
                        <Button variant="secondary" size="sm" iconLeft="globe" onClick={() => setOpenUp(h)}>Let anyone open</Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={!!openUp}
        onClose={() => setOpenUp(null)}
        tone="default"
        title={openUp ? `Let anyone with the link open “${openUp.title || openUp.slug}”?` : "Let anyone open it?"}
        body={<p className="text-body text-text-secondary">It opens for anyone with its link or this folder&apos;s link, everywhere it opens. People you added keep their access.</p>}
        confirmLabel="Let anyone open"
        onConfirm={async () => {
          const h = openUp;
          if (!h?.slug) return;
          try {
            await setAccessLevel(h.slug, "link");
          } catch (e) {
            throw new Error(e instanceof Error && e.message ? e.message : "Couldn't change it. Try again.");
          }
          purgeDocument(h.slug);
          setOpenUp(null);
          workspaceChanged(workspaceId);
          toast.success("Anyone with the link can open it now");
          await load();
        }}
      />
    </div>,
    document.body,
  );
}
