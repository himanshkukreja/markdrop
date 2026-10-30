"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, EmptyState, MarkdropLoader } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { canEditRole, docsErrorMessage, docsErrorStatus, getSite, isAdminRole, type DocsRole, type Site } from "@/lib/docsSites";

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

export interface SiteCtx {
  site: Site;
  setSite: (s: Site) => void;
  reload: () => Promise<void>;
  wsId: string;
  /** `/w/<ws>/docs/<site>`: the site's screens hang off this. */
  base: string;
  /** `/w/<ws>/docs`: the workspace's list. */
  listHref: string;
  role: DocsRole;
  isAdmin: boolean;
  canEdit: boolean;
}

const Ctx = createContext<SiteCtx | null>(null);

export function useSite(): SiteCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSite outside SiteProvider");
  return v;
}

export const docsListHref = (wsId: string) => `/w/${encodeURIComponent(wsId)}/docs`;
export const siteBase = (wsId: string, siteId: string) => `${docsListHref(wsId)}/${encodeURIComponent(siteId)}`;

/**
 * Loads one docs site for every screen under /w/<ws>/docs/<site> (editor, design, publish,
 * settings, import) and keeps it while you move between them (it lives in the segment's layout).
 */
export function SiteProvider({ wsId, siteId, children }: { wsId: string; siteId: string; children: React.ReactNode }) {
  const base = siteBase(wsId, siteId);
  const { ready } = useStudioSession(base);
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      setSite(await getSite(siteId));
      setError(null);
    } catch (e) {
      setError({ status: docsErrorStatus(e), message: docsErrorMessage(e, "Couldn't load this docs site.") });
    }
  }, [siteId]);

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  if (!site && error) {
    return (
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-app flex-1 flex-col px-4 py-16 outline-none">
        <h1 className="md-visually-hidden">Docs site</h1>
        <EmptyState
          icon="alertCircle"
          title={error.status === 404 ? "This docs site doesn't exist" : error.status === 403 ? "You don't have access to this docs site" : "We couldn't open this docs site"}
          description={error.status === 404 || error.status === 403 ? "It may have been deleted, or you may no longer be a member of its workspace." : error.message}
          actions={
            <>
              {error.status !== 404 && error.status !== 403 && <Button variant="primary" onClick={() => void reload()}>Try again</Button>}
              <Button variant="secondary" href={docsListHref(wsId)} iconLeft="arrowLeft">Back to Docs sites</Button>
            </>
          }
        />
      </main>
    );
  }
  if (!site) return <StudioLoader label="Loading docs site" />;

  const role: DocsRole = site.your_role ?? "viewer";
  return (
    <Ctx.Provider value={{ site, setSite, reload, wsId, base, listHref: docsListHref(wsId), role, isAdmin: isAdminRole(role), canEdit: canEditRole(role) }}>
      {children}
    </Ctx.Provider>
  );
}
