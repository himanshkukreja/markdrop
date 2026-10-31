"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { docsErrorMessage, listAllSites, type AllSitesResponse, type SiteSummary } from "@/lib/docsSites";

/** The site open in the studio right now (the header's switcher and workspace badge show it). */
export type CurrentSite = Pick<SiteSummary, "id" | "name" | "workspace_id" | "preset" | "your_role"> & {
  settings?: { theme: { preset: SiteSummary["preset"]; brand: { enabled: boolean; logo_url?: string | null; accent?: string | null; colors: string[] } } };
};

interface StudioCtx {
  /** Every site you can open (GET /docs-sites?scope=all); null until loaded. */
  all: AllSitesResponse | null;
  allError: string;
  reloadAll: () => Promise<void>;
  current: CurrentSite | null;
  setCurrent: (s: CurrentSite | null) => void;
}

const Ctx = createContext<StudioCtx | null>(null);

export function useStudio(): StudioCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStudio outside StudioProvider");
  return v;
}

/** The workspace name for a site (from the all-sites listing), or null for personal / unknown. */
export function useWorkspaceName(workspaceId: string | null | undefined): string | null {
  const { all } = useStudio();
  if (!workspaceId) return null;
  return all?.workspaces.find((w) => w.id === workspaceId)?.name ?? null;
}

/**
 * Studio-wide state: the all-sites listing (loaded once a session is there, refreshed on demand —
 * after creating, renaming or deleting a site) and the site currently open.
 */
export function StudioProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [all, setAll] = useState<AllSitesResponse | null>(null);
  const [allError, setAllError] = useState("");
  const [current, setCurrent] = useState<CurrentSite | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const reloadAll = useCallback(() => {
    if (inflight.current) return inflight.current;
    const p = (async () => {
      try {
        setAll(await listAllSites());
        setAllError("");
      } catch (e) {
        setAllError(docsErrorMessage(e, "Couldn't load your guides."));
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }, []);

  useEffect(() => {
    if (!loading && user) void reloadAll();
  }, [loading, user, reloadAll]);

  const value = useMemo(() => ({ all, allError, reloadAll, current, setCurrent }), [all, allError, reloadAll, current]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
