"use client";

/**
 * Shared with me (/shared) and Recent (/recent): cross-workspace lists for the signed-in person,
 * with rows like the folder view. Both lists come from the server already re-checked against the
 * access rules; a file whose access was taken away simply isn't in them.
 *
 * Shared with me also carries the owner's side of "No dead ends": access requests waiting on the
 * caller, each opening /requests/<id>.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Anchor, Avatar, Badge, Button, ConfirmDialog, EmptyState, copyText, useToast, type MenuEntry } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { PageHeader } from "@/components/shell/PageHeader";
import { useMounted } from "@/components/shell/useLocation";
import { ListSkeleton } from "@/components/dashboard/ListParts";
import { relativeTime } from "@/components/dashboard/format";
import { usePhone } from "@/components/dashboard/hooks";
import ShareDialog from "@/components/access/ShareDialog";
import { removePerson } from "@/lib/access";
import { useAuth } from "@/contexts/AuthContext";
import {
  listAccessRequests, listRecentPage, listSharedWithMe, requestTitle, requesterName, type AccessRequest, type PersonalItem,
  type TypeCounts,
} from "@/lib/me";
import { TYPE_META, typeChipsWorthShowing } from "@/lib/fileTypes";
import { TypeChips, useTypeFilter, type ByType } from "@/components/dashboard/TypeChips";
import { errorStatus, listWorkspaces, openHref, openOnDomainEntry } from "@/lib/workspaces";
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
  const [leaving, setLeaving] = useState<PersonalItem | null>(null);
  // The type chips (lib/fileTypes): ?type= in the URL, remembered for this list on this device.
  const { type, setType, ready } = useTypeFilter(user ? mode : null);
  /** Per-type counts of the whole list (not the filter); "unknown" from an older server. */
  const [byType, setByType] = useState<ByType | "unknown" | null>(null);
  const seq = useRef(0);
  /** The type the rows on screen were loaded for. */
  const [loadedType, setLoadedType] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready) return;
    const id = ++seq.current;
    setError("");
    const t = type === "all" ? undefined : type;
    const counted = (c: TypeCounts | undefined) => (c === undefined ? "unknown" as const : c);
    try {
      if (mode === "shared") {
        const r = await listSharedWithMe(null, { type: t, counts: true });
        if (id !== seq.current) return;
        setItems(r.items);
        setCursor(r.next_cursor);
        // null: too many to count — keep the chips as they were, if any.
        const c = counted(r.count_by_type);
        if (c !== null) setByType(c);
      } else {
        const r = await listRecentPage(t);
        if (id !== seq.current) return;
        setItems(r.items);
        setCursor(null);
        const c = counted(r.count_by_type);
        if (c !== null) setByType(c);
      }
      setLoadedType(type);
    } catch (e) {
      if (id !== seq.current) return;
      const s = errorStatus(e);
      setItems([]);
      setLoadedType(type);
      setError(s === 404 || s === 405 ? `${copy.title} isn't available on this server yet.` : e instanceof Error && e.message ? e.message : "Couldn't load this list.");
    }
  }, [mode, copy.title, ready, type]);

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
      const r = await listSharedWithMe(cursor, { type: type === "all" ? undefined : type });
      setItems((xs) => [...(xs ?? []), ...r.items.filter((n) => !(xs ?? []).some((x) => x.slug === n.slug))]);
      setCursor(r.next_cursor);
    } catch {
      toast.error("Couldn't load more. Try again.");
    } finally {
      setMore(false);
    }
  }

  const menu = (it: PersonalItem): MenuEntry[] => {
    const out: MenuEntry[] = [{ label: "Open", icon: "external", href: openHref(it.slug, it.url, it.encrypted), external: true }];
    const onDomain = openOnDomainEntry(it.url, it.encrypted);
    if (onDomain) out.push(onDomain);
    if (!it.encrypted) {
      out.push({ label: "Copy link", icon: "copy", onClick: () => { void copyText(it.url).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link"))); } });
    }
    if (it.workspace && it.folder) out.push({ label: <>Open <span className="ph-sensitive ph-mask">“{it.folder.name}”</span></>, icon: "folder", href: `/w/${encodeURIComponent(it.workspace.id)}/f/${encodeURIComponent(it.folder.id)}` });
    // Anyone added by email can take themselves off, whether or not they may share it on.
    if (mode === "shared" && user?.email) out.push({ label: "Remove me", icon: "userX", danger: true, separated: true, onClick: () => setLeaving(it) });
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
          <p className="text-caption text-text-muted">People asking to open something of yours. <ReadMore topic="requestAccess" /></p>
          {/* ph-no-capture: requesters' names and emails, and the titles they asked for. */}
          <ul className="ph-no-capture m-0 flex list-none flex-col p-0">
            {requests.map((r) => (
              <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-3 border-t border-border py-2.5">
                <Avatar name={requesterName(r)} size="md" />
                <div className="min-w-0 flex-[1_1_240px]">
                  <div className="truncate text-body-strong text-text" dir="auto">
                    {requesterName(r)} asked to {r.role_requested === "editor" ? "edit" : "open"} “{requestTitle(r)}”
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

      {typeChipsWorthShowing(type, byType) && (
        <TypeChips value={type} counts={byType ? { byType } : null} onChange={setType} />
      )}

      {items === null || loadedType !== type ? (
        <ListSkeleton rows={4} label="Loading" />
      ) : items.length === 0 && !error && type !== "all" ? (
        <EmptyState
          icon={TYPE_META[type].icon}
          title={mode === "shared" ? `No ${TYPE_META[type].noun} shared with you` : `No ${TYPE_META[type].noun} opened lately`}
          description={mode === "shared" ? "When someone adds you to one by email, it shows up here." : "The ones you open while signed in show up here."}
          actions={<Button variant="secondary" onClick={() => setType("all")}>Show every type</Button>}
        />
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
                  file={{ slug: it.slug, kind: it.kind, mime: it.mime, renderer: it.renderer, original_filename: it.original_filename, editor: it.editor, type_label: it.type_label }}
                  title={title}
                  href={openHref(it.slug, it.url, it.encrypted)}
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
                      className="md-focus md-row-chip inline-flex max-w-40 shrink-0 items-center rounded-sm bg-surface-active px-1.5 text-micro text-text-secondary no-underline hover:underline">
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

      <ConfirmDialog
        open={!!leaving}
        onClose={() => setLeaving(null)}
        title={leaving ? <>Remove yourself from <span className="ph-sensitive ph-mask">“{itemTitle(leaving)}”</span>?</> : "Remove yourself?"}
        body="It leaves Shared with me, and you can't open it with your email any more. If the link is open to more people, it still works for you like it does for them. To get back in, ask the owner to add you again."
        confirmLabel="Remove me"
        onConfirm={async () => {
          const it = leaving!;
          await removePerson(it.slug, user!.email);
          setLeaving(null);
          setItems((xs) => (xs ?? []).filter((x) => x.slug !== it.slug));
          toast.success(`You were removed from “${itemTitle(it)}”.`);
        }}
      />

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
