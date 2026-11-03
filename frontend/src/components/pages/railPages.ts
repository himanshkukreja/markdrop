"use client";

/**
 * Pages in the workspace rail: under each open folder (and the workspace's top level), its pages,
 * each with its sub-pages a level down. Nothing loads until a branch opens: a folder's pages come
 * from its items (GET /workspaces/{id}/items, the rows with `editor: "blocks"` and no parent), a
 * page's sub-pages from GET /documents/{slug}/children. Everything is already filtered by the API
 * to what this person can open.
 */
import { useEffect, useRef, useState } from "react";
import { listChildren, PagesApiError } from "@/lib/pages";
import { listWorkspaceItems } from "@/lib/workspaces";
import { useWorkspaceChanged } from "@/lib/workspaceStore";

export interface RailPage {
  slug: string;
  title: string | null;
  has_children: boolean;
}

export const railPageKey = (wsId: string, slug: string) => `ws:${wsId}:page:${slug}`;

type Slot = RailPage[] | "loading" | "error";

function parse(key: string): { ws: string; folder?: string; page?: string } | null {
  const m = /^ws:([^:]+):(root|folder|page)(?::(.+))?$/.exec(key);
  if (!m) return null;
  if (m[2] === "root") return { ws: m[1]!, folder: "root" };
  if (m[2] === "folder" && m[3]) return { ws: m[1]!, folder: m[3] };
  if (m[2] === "page" && m[3]) return { ws: m[1]!, page: m[3] };
  return null;
}

async function load(key: string): Promise<RailPage[]> {
  const p = parse(key);
  if (!p) return [];
  if (p.page) {
    const kids = await listChildren(p.page);
    return kids.map((k) => ({ slug: k.slug, title: k.title, has_children: !!k.has_children }));
  }
  const r = await listWorkspaceItems(p.ws, { folder: p.folder!, kind: "markdown", limit: 100 });
  return r.items
    .filter((it) => (it as { editor?: string | null }).editor === "blocks" && !(it as { parent_id?: string | null }).parent_id)
    .map((it) => ({ slug: it.slug, title: it.title, has_children: !!(it as { has_children?: boolean }).has_children }));
}

/** The pages under every open rail key (undefined: not loaded yet). */
export function useRailPages(expanded: Set<string>) {
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const asked = useRef(new Set<string>());
  const [gen, setGen] = useState(0);

  useEffect(() => {
    for (const key of expanded) {
      if (asked.current.has(key) || !parse(key)) continue;
      asked.current.add(key);
      setSlots((s) => ({ ...s, [key]: "loading" }));
      load(key)
        .then((pages) => setSlots((s) => ({ ...s, [key]: pages })))
        .catch((e) => {
          // An API without pages (404 on /children) is just "no pages".
          setSlots((s) => ({ ...s, [key]: e instanceof PagesApiError && e.status === 404 ? [] : "error" }));
        });
    }
  }, [expanded, gen]);

  // A workspace changed (a page created, moved or deleted): ask again next time it's open.
  useWorkspaceChanged("*", () => {
    asked.current.clear();
    setSlots({});
    setGen((g) => g + 1);
  });

  return (key: string): RailPage[] | undefined => {
    const s = slots[key];
    return Array.isArray(s) ? s : s === "error" ? [] : undefined;
  };
}
