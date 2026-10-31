"use client";

/**
 * Insights for a Markdrop Guides site (site.json `insights`, the guide's Insights endpoint; set
 * only for a guide whose owner left Insights on). Two small beacons to `<insights>/event`, and
 * nothing else: no cookie, no storage, no id, no third party. The API (backend
 * services/guide_insights.py) keeps the page path, the device class and the country, and counts a
 * visitor by a hash that changes every day.
 *
 *   {k: "view", p}         a client-side navigation. The first page of a visit is counted by the
 *                          edge when it serves the HTML, so it is never sent from here.
 *   {k: "search", q, n, p} a search that settled: 3+ characters, unchanged for SETTLE_MS, sent
 *                          once per query per page load, with how many results it had (0 is how
 *                          the guide's team learns what its docs are missing).
 *
 * Sent as text/plain (no CORS preflight) with keepalive, and never surfaces an error. Sites
 * without `insights` (docs.markdrop.in, self-hosted docs) render none of this.
 */
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useDocsSite } from "./site";

export const SETTLE_MS = 1500;
export const MIN_QUERY = 3;

export function sendInsight(base: string, body: Record<string, unknown>) {
  try {
    void fetch(`${base}/event`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  } catch {
    /* never surfaces */
  }
}

/** A query as the guide's team will see it: one space between words, lowercase (the API normalises it again). */
export function settledQuery(raw: string): string | null {
  const q = raw.replace(/\s+/g, " ").trim().toLowerCase();
  return q.length >= MIN_QUERY ? q.slice(0, 100) : null;
}

/** Client-side navigations after the first page (mounted once by the docs layout). */
export function InsightsBeacon({ base }: { base: string }) {
  const pathname = usePathname();
  const last = useRef<string | null>(null);
  useEffect(() => {
    const p = window.location.pathname;
    if (last.current === null || last.current === p) {
      last.current = p;
      return;
    }
    last.current = p;
    sendInsight(base, { k: "view", p });
  }, [pathname, base]);
  return null;
}

/** The search palette's settled query and its result count (`results` null while the index loads). */
export function useSearchInsight(query: string, results: number | null, active: boolean) {
  const { insights } = useDocsSite();
  const sent = useRef(new Set<string>());
  useEffect(() => {
    if (!insights || !active || results === null) return;
    const q = settledQuery(query);
    if (!q || sent.current.has(q)) return;
    const t = window.setTimeout(() => {
      sent.current.add(q);
      sendInsight(insights, { k: "search", q, n: results, p: window.location.pathname });
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [insights, active, query, results]);
}
