"use client";

/**
 * Jira in a page as readers see it (PageRenderer loads this only when the page has Jira in it):
 * every chip, card and list of the page shares one store (one GET …/items, one live subscription),
 * kept in a small registry by page and viewer.
 */
import { useEffect, useState } from "react";
import { specOf, type JiraListSpec } from "@/lib/jiraPages";
import { JiraCard, JiraInline, JiraList } from "./JiraBlocks";
import { JiraPagesStore } from "./store";

type Live = ((fn: (msg: Record<string, unknown>) => void) => () => void) | null | undefined;

export interface JiraReaderEnv {
  slug: string;
  viewer: string | null;
  subscribeLive?: Live;
  /** The page's Jira chips and cards ("site/KEY …"): a change re-reads the store. */
  refsKey: string;
}

interface Entry { store: JiraPagesStore; users: number; refs: string | null; off: (() => void) | null; timer: number | null }
const registry = new Map<string, Entry>();

function entryFor(env: JiraReaderEnv): Entry {
  const id = `${env.slug}|${env.viewer ?? ""}`;
  let e = registry.get(id);
  if (!e) registry.set(id, (e = { store: new JiraPagesStore(env.slug, env.viewer), users: 0, refs: null, off: null, timer: null }));
  return e;
}

/** The page's shared store: loaded once, again when its issues change, and on live nudges. */
export function useSharedJiraStore(env: JiraReaderEnv): JiraPagesStore {
  const [entry] = useState(() => entryFor(env));
  useEffect(() => {
    const e = entry;
    e.users += 1;
    if (e.timer !== null) { window.clearTimeout(e.timer); e.timer = null; }
    if (!e.off) {
      const offLive = env.subscribeLive?.((msg) => { if (msg?.type === "jira") e.store.reload(); }) ?? null;
      document.addEventListener("visibilitychange", e.store.onVisible);
      e.off = () => { offLive?.(); document.removeEventListener("visibilitychange", e.store.onVisible); };
    }
    return () => {
      e.users -= 1;
      if (e.users > 0) return;
      // Gone for good (not just a re-render): let go of the socket and the store.
      e.timer = window.setTimeout(() => {
        if (e.users > 0) return;
        e.off?.();
        e.off = null;
        registry.delete(`${env.slug}|${env.viewer ?? ""}`);
      }, 2000);
    };
  }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (entry.refs === env.refsKey) return;
    entry.refs = env.refsKey;
    void entry.store.load();
  }, [entry, env.refsKey]);
  return entry.store;
}

export function JiraReaderBlock({ env, kind, site, issueKey, attrs }: {
  env: JiraReaderEnv; kind: "chip" | "card" | "list"; site: string | null; issueKey: string | null; attrs: Record<string, string> | null;
}) {
  const store = useSharedJiraStore(env);
  if (kind === "list") {
    const spec: JiraListSpec | null = attrs ? specOf(attrs) : null;
    return spec ? <JiraList store={store} spec={spec} slug={env.slug} /> : null;
  }
  if (!issueKey) return null;
  if (kind === "card") return <JiraCard store={store} site={site} issueKey={issueKey} slug={env.slug} />;
  return <JiraInline store={store} site={site} issueKey={issueKey} slug={env.slug} />;
}
