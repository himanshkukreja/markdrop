"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, EmptyState, MarkdropLoader } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { canEditRole, canReviewRole, docsErrorMessage, docsErrorStatus, getSite, isAdminRole, type DocsRole, type Site } from "@/lib/docsSites";
import { scopeOf, siteBase, studioHome } from "./routes";
import { useStudio } from "./studio/StudioContext";

/** Studio pages need a session: wait for auth, else go to /login and come back. */
export function useStudioSession(next: string) {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading || user) return;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [loading, user, router, next]);
  return { user, ready: !loading && !!user };
}

export function StudioLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[70dvh] flex-1 items-center justify-center" aria-busy="true">
      <MarkdropLoader label={label} />
    </div>
  );
}

/**
 * What a role may do in Markdrop Guides. The one place the UI decides it: from `your_role`, the
 * caller's effective Guides role on the site, which only the API decides (workspace owner and
 * admins → admin; otherwise the role a studio admin gave, per workspace or per site).
 *
 *   admin     settings, design, people, approve, publish, restore, delete, take over a page
 *   reviewer  edit + publish (or submit) + approve / send back other people's reviews
 *   editor    edit pages, upload, publish (or submit for review when it's required)
 *   viewer    read drafts, preview, history
 */
export function studioPermissions(role: DocsRole) {
  return {
    role,
    isAdmin: isAdminRole(role),
    canReview: canReviewRole(role),
    canEdit: canEditRole(role),
    canManagePeople: isAdminRole(role),
  };
}

export interface SiteCtx {
  site: Site;
  setSite: (s: Site) => void;
  reload: () => Promise<void>;
  /** The site's workspace, or null for a personal site. */
  wsId: string | null;
  /** `/guides/<site>`: the site's screens hang off this. */
  base: string;
  /** Markdrop Guides' home filtered to the site's workspace (or personal sites). */
  listHref: string;
  role: DocsRole;
  isAdmin: boolean;
  /** Approve or send back other people's reviews (reviewers and admins). */
  canReview: boolean;
  canEdit: boolean;
  /** Site › Settings › People (admins). */
  canManagePeople: boolean;
}

const Ctx = createContext<SiteCtx | null>(null);

export function useSite(): SiteCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSite outside SiteProvider");
  return v;
}

/**
 * Loads one docs site for every screen under /guides/<site> (editor, design, publish,
 * settings, import) and keeps it while you move between them (it lives in the segment's layout).
 * The studio header shows it (site switcher, workspace badge) while it's open.
 */
export function SiteProvider({ siteId, children }: { siteId: string; children: React.ReactNode }) {
  const base = siteBase(siteId);
  const { ready } = useStudioSession(base);
  const { setCurrent, reloadAll } = useStudio();
  const [site, setSiteState] = useState<Site | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  const siteRef = useRef<Site | null>(null);
  const setSite = useCallback((s: Site) => {
    const prev = siteRef.current;
    siteRef.current = s;
    setSiteState(s);
    // A rename or a new theme shows in the switcher and on the studio's home too.
    if (prev && (prev.name !== s.name || prev.settings.theme.preset !== s.settings.theme.preset || prev.status !== s.status)) void reloadAll();
  }, [reloadAll]);

  const reload = useCallback(async () => {
    try {
      const s = await getSite(siteId);
      siteRef.current = s;
      setSiteState(s);
      setError(null);
    } catch (e) {
      setError({ status: docsErrorStatus(e), message: docsErrorMessage(e, "Couldn't load this guide.") });
    }
  }, [siteId]);

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  useEffect(() => {
    if (site) setCurrent(site);
  }, [site, setCurrent]);
  useEffect(() => () => setCurrent(null), [setCurrent]);

  if (!site && error) {
    return (
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-app flex-1 flex-col px-4 py-16 outline-none">
        <h1 className="md-visually-hidden">Guide</h1>
        <EmptyState
          icon="alertCircle"
          title={error.status === 404 ? "This guide doesn't exist" : error.status === 403 ? "You don't have access to this guide" : "We couldn't open this guide"}
          description={error.status === 404 || error.status === 403 ? "It may have been deleted, or you don't have a Guides role on it. A Guides admin of its workspace can give you one." : error.message}
          actions={
            <>
              {error.status !== 404 && error.status !== 403 && <Button variant="primary" onClick={() => void reload()}>Try again</Button>}
              <Button variant="secondary" href={studioHome()} iconLeft="arrowLeft">All guides</Button>
            </>
          }
        />
      </main>
    );
  }
  if (!site) return <StudioLoader label="Loading guide" />;

  const perms = studioPermissions(site.your_role ?? "viewer");
  return (
    <Ctx.Provider value={{ site, setSite, reload, wsId: site.workspace_id, base, listHref: studioHome(scopeOf(site)), ...perms }}>
      {children}
    </Ctx.Provider>
  );
}
