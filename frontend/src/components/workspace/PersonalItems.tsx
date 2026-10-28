"use client";

/**
 * Shared with me (/shared) and Recent (/recent): cross-workspace lists for the signed-in person,
 * with rows like the folder view. Both lists come from the server already re-checked against the
 * access rules; a file whose access was taken away simply isn't in them.
 *
 * Shared with me also carries the owner's side of "No dead ends": access requests waiting on the
 * caller, each opening /requests/<id>.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Anchor, Avatar, Badge, Button, EmptyState, copyText, useToast, type MenuEntry } from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { useMounted } from "@/components/shell/useLocation";
import { ListSkeleton } from "@/components/dashboard/ListParts";
import { relativeTime } from "@/components/dashboard/format";
import { usePhone } from "@/components/dashboard/hooks";
import ShareDialog from "@/components/access/ShareDialog";
import { useAuth } from "@/contexts/AuthContext";
import {
  listAccessRequests, listRecent, listSharedWithMe, requestTitle, requesterName, type AccessRequest, type PersonalItem,
} from "@/lib/me";
import { errorStatus, listWorkspaces } from "@/lib/workspaces";
import { ItemRow } from "./folder/ItemRow";
import { displayAddress, itemTitle, teamName } from "./folder/items";

type Mode = "shared" | "recent";

const COPY: Record<Mode, { title: string; description: string; emptyTitle: string; emptyText: string }> = {
  shared: {
    title: "Shared with me",
    description: "Files people added you to by email. Your own files are in My files.",
    emptyTitle: "Nothing shared with you yet",
    emptyText: "When someone adds you to a file by email, it shows up here.",
  },
  recent: {
    title: "Recent",
    description: "What you opened lately, newest first.",
    emptyTitle: "Nothing opened yet",
    emptyText: "Files you open while signed in show up here, so you can get back to them.",
  },
};

export default function PersonalItems({ mode }: { mode: Mode }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const mounted = useMounted();
  const phone = usePhone();
  const toast = useToast();
  const copy = COPY[mode];

  useEffect(() => {
    if (authLoading || !mounted || user) return;
    router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [authLoading, mounted, user, router]);

  const [items, setItems] = useState<PersonalItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [shareFor, setShareFor] = useState<PersonalItem | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      if (mode === "shared") {
        const r = await listSharedWithMe();
        setItems(r.items);
        setCursor(r.next_cursor);
      } else {
        setItems(await listRecent());
        setCursor(null);
      }
    } catch (e) {
      const s = errorStatus(e);
      setItems([]);
      setError(s === 404 || s === 405 ? `${copy.title} isn't available on this server yet.` : e instanceof Error && e.message ? e.message : "Couldn't load this list.");
    }
  }, [mode, copy.title]);

  useEffect(() => { if (user) void load(); }, [user, load]);
  // Team names ("Acme team") come from the workspaces' site names.
  const [teams, setTeams] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!user) return;
    listWorkspaces().then((ws) => setTeams(Object.fromEntries(ws.map((w) => [w.id, teamName(w)])))).catch(() => {});
  }, [user]);
  useEffect(() => {
    if (!user || mode !== "shared") return;
    listAccessRequests("pending").then((r) => setRequests(r.requests)).catch(() => setRequests([]));
  }, [user, mode]);

  async function loadMore() {
    if (!cursor || more) return;
    setMore(true);
    try {
      const r = await listSharedWithMe(cursor);
      setItems((xs) => [...(xs ?? []), ...r.items.filter((n) => !(xs ?? []).some((x) => x.slug === n.slug))]);
      setCursor(r.next_cursor);
    } catch {
      toast.error("Couldn't load more. Try again.");
    } finally {
      setMore(false);
    }
  }

  const menu = (it: PersonalItem): MenuEntry[] => {
    const out: MenuEntry[] = [{ label: "Open", icon: "external", href: `/${it.slug}` }];
    if (!it.encrypted) {
      out.push({ label: "Copy link", icon: "copy", onClick: () => { void copyText(it.url).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link"))); } });
    }
    if (it.workspace && it.folder) out.push({ label: `Open “${it.folder.name}”`, icon: "folder", href: `/w/${encodeURIComponent(it.workspace.id)}/f/${encodeURIComponent(it.folder.id)}` });
    return out;
  };

  if (authLoading || !user) return <ListSkeleton label="Loading" />;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader title={copy.title} description={copy.description} />

      {mode === "shared" && requests.length > 0 && (
        <section aria-labelledby="md-requests-h" className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-4">
          <h2 id="md-requests-h" className="flex items-center gap-2 text-h4 text-text">
            Access requests <Badge size="sm" tone="info">{requests.length}</Badge>
          </h2>
          <p className="text-caption text-text-muted">People asking to open something of yours.</p>
          <ul className="m-0 flex list-none flex-col p-0">
            {requests.map((r) => (
              <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-3 border-t border-border py-2.5">
                <Avatar name={requesterName(r)} size="md" />
                <div className="min-w-0 flex-[1_1_240px]">
                  <div className="truncate text-body-strong text-text" dir="auto">
                    {requesterName(r)} asked to open “{requestTitle(r)}”
                  </div>
                  <div className="truncate text-caption text-text-muted">{r.requester.email} · {relativeTime(r.created_at)}</div>
                </div>
                <Button size="sm" variant="secondary" href={`/requests/${encodeURIComponent(r.id)}`}>Review</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <Alert tone={error.includes("isn't available") ? "info" : "danger"} actions={error.includes("isn't available") ? undefined : <Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button>}>{error}</Alert>}

      {items === null ? (
        <ListSkeleton rows={4} label="Loading" />
      ) : items.length === 0 && !error ? (
        <EmptyState
          icon={mode === "shared" ? "inbox" : "clock"}
          title={copy.emptyTitle}
          description={copy.emptyText}
          actions={<Button variant="secondary" href="/dashboard">Go to My files</Button>}
        />
      ) : items.length > 0 ? (
        <section aria-label={copy.title} className="flex min-w-0 flex-col gap-2">
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {items.map((it) => {
              const title = itemTitle(it);
              const where = it.workspace ? [it.workspace.name, ...(it.folder ? [it.folder.name] : [])].join(" › ") : null;
              return (
                <ItemRow
                  key={it.slug}
                  file={{ slug: it.slug, kind: it.kind, mime: it.mime, renderer: it.renderer, original_filename: it.original_filename }}
                  title={title}
                  href={`/${it.slug}`}
                  address={it.encrypted ? "Encrypted" : displayAddress(it.url)}
                  views={null}
                  by={mode === "shared"
                    ? [it.owner?.name ? `From ${it.owner.name}` : null, it.role === "editor" ? "Can edit" : it.role === "viewer" ? "Can view" : null].filter(Boolean).join(" · ") || null
                    : it.owner?.is_you ? "You" : it.owner?.name ?? null}
                  when={(mode === "shared" ? it.granted_at : it.viewed_at) ?? it.updated_at}
                  access={it.access}
                  team={it.workspace ? teams[it.workspace.id] ?? it.workspace.name : null}
                  hasPassword={it.has_password}
                  encrypted={!!it.encrypted}
                  onAccess={it.can?.share ? () => setShareFor(it) : null}
                  copy={it.encrypted ? null : it.url}
                  menu={menu(it)}
                  menuLabel={`Actions for ${title}`}
                  phone={phone}
                  badges={mode === "shared" && it.new ? <Badge size="sm" tone="info">New</Badge> : undefined}
                  chip={where ? (
                    <Anchor href={`/w/${encodeURIComponent(it.workspace!.id)}${it.folder ? `/f/${encodeURIComponent(it.folder.id)}` : ""}`}
                      className="md-focus inline-flex max-w-40 shrink-0 items-center rounded-sm bg-surface-active px-1.5 text-micro text-text-secondary no-underline hover:underline">
                      <span className="truncate" dir="auto">{where}</span>
                    </Anchor>
                  ) : undefined}
                />
              );
            })}
          </ul>
          {cursor && (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" onClick={() => void loadMore()} loading={more}>Load more</Button>
            </div>
          )}
        </section>
      ) : null}

      {shareFor && (
        <ShareDialog
          slug={shareFor.slug}
          title={itemTitle(shareFor)}
          kind={shareFor.kind}
          shareUrl={shareFor.encrypted ? undefined : shareFor.url}
          location={{ workspaceId: shareFor.workspace?.id ?? null, folderId: shareFor.folder?.id ?? null }}
          onClose={() => setShareFor(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
