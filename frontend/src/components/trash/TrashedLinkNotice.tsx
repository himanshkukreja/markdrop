"use client";

/**
 * The 404 page's trash notice. The 404 HTML is shared by every missing address, so this renders
 * its children (the normal "Nothing at this link") on the server and on first paint, and only after
 * mount — on markdrop.in itself (never a workspace's own domain), for a single-segment path, and
 * only when this browser is signed in or holds the link's edit secret — asks the API whether the
 * link is in the trash. The API answers only someone who could edit it (404 for everyone else), so
 * nobody else sees any difference. When it is, the page says so, with Restore when they may.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button } from "@/components/ui";
import { isPrimaryHost } from "@/components/tenant/hosts";
import { getToken } from "@/lib/api";
import type { TrashItem } from "@/lib/trash";
import { TrashTile, trashDeleted, trashName, trashNoun } from "./parts";

const SLUG = /^[A-Za-z0-9_-]{3,64}$/;

function slugOfPath(pathname: string): string | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length !== 1) return null;
  let s: string;
  try {
    s = decodeURIComponent(segs[0]!);
  } catch {
    return null;
  }
  return SLUG.test(s) ? s : null;
}

function longDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function TrashedLinkNotice({ children }: { children: ReactNode }) {
  const [found, setFound] = useState<{ item: TrashItem; slug: string; secret: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isPrimaryHost(window.location.host)) return;
    const slug = slugOfPath(window.location.pathname);
    if (!slug) return;
    let secret: string | null = null;
    try {
      secret = sessionStorage.getItem(`secret:${slug}`);
    } catch {
      /* storage blocked */
    }
    if (!getToken() && !secret) return;
    let live = true;
    import("@/lib/trash")
      .then((m) => m.trashLookup(slug, secret))
      .then((item) => { if (live && item) setFound({ item, slug, secret }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  if (!found) return <>{children}</>;
  const { item, slug, secret } = found;
  const noun = trashNoun(item);
  const until = longDate(item.restore_until);
  const left = item.days_left <= 1 ? "last day" : `${item.days_left} days left`;

  async function restore() {
    setBusy(true);
    setError("");
    try {
      const m = await import("@/lib/trash");
      const r = await m.restoreFromTrash(item.key, secret);
      await Promise.all([m.purgeCached(slug), r.slug && r.slug !== slug ? m.purgeCached(r.slug) : null]);
      // This link (restoring a sub-page can bring back the page it was deleted with, too).
      window.location.assign(`/${encodeURIComponent(slug)}`);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't restore it. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-[30rem] flex-col items-center gap-5 text-center">
      <span className="scale-150 py-2"><TrashTile item={item} /></span>
      <h1 className="text-h1 text-text">This {noun} is in the trash</h1>
      <p className="ph-sensitive ph-mask m-0 max-w-full text-body-lg text-text [overflow-wrap:anywhere]" dir="auto">
        {item.hidden ? "A private item" : `“${trashName(item)}”`}
      </p>
      <p className="ph-sensitive ph-mask m-0 text-body text-text-secondary">
        {trashDeleted(item)}.{until ? <> It will be deleted for good on {until} ({left}).</> : null}
        {item.deleted_with?.folder ? <> It was deleted with the folder “{item.deleted_with.folder}”.</> : null}
        {item.deleted_with?.title && !item.deleted_with.folder ? <> It was deleted with the page “{item.deleted_with.title}”.</> : null}
      </p>
      {error && <Alert tone="danger" className="w-full text-left">{error}</Alert>}
      {item.can.restore ? (
        <div className="mt-2 flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
          <Button variant="primary" size="lg" iconLeft="undo" loading={busy} onClick={() => void restore()}>Restore</Button>
          {getToken() && <Button variant="secondary" size="lg" href="/trash">Open Trash</Button>}
        </div>
      ) : (
        <p className="m-0 text-body text-text-secondary">Ask its owner to restore it.</p>
      )}
    </div>
  );
}

export default TrashedLinkNotice;
