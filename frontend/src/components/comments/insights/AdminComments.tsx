"use client";

/**
 * Admin › Analytics: comments across Markdrop (Track C, GET /api/v1/admin/analytics/comments) — threads and
 * messages in the range, open now, resolved, items and people commenting, AI answers in threads, the typical
 * time to a first reply, and the items with the most discussion.
 */
import { useEffect, useState } from "react";
import { StatTile } from "@/components/kit/StatTile";
import { Anchor } from "@/components/ui";
import { duration, type AdminComments as Data } from "@/lib/commentsInsights";

type Get = <T>(path: string, params: Record<string, string | undefined>) => Promise<T>;

const compact = (n: number) => n.toLocaleString("en-US");

export function AdminComments({ get, params }: { get: Get; params: Record<string, string | undefined> }) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const range = params.range;
  useEffect(() => {
    let alive = true;
    setFailed(false);
    get<Data>("comments", { range })
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [get, range]);

  const k = data?.kpis;
  return (
    <section aria-labelledby="admin-comments-h" data-testid="admin-comments">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 id="admin-comments-h" className="text-h4 text-text">Comments</h2>
        <p className="text-caption text-text-secondary">Threads on pages and documents, from Markdrop&apos;s own records</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
        <StatTile size="md" loading={!k && !failed} error={failed} label="New threads" value={compact(k?.threads ?? 0)} />
        <StatTile size="md" loading={!k && !failed} error={failed} label="Messages" value={compact(k?.messages ?? 0)} />
        <StatTile size="md" loading={!k && !failed} error={failed} label="Resolved" value={compact(k?.resolved ?? 0)} />
        <StatTile size="md" loading={!k && !failed} error={failed} label="Open now" value={compact(k?.open_now ?? 0)} caption="Across every item" />
        <StatTile size="md" loading={!k && !failed} error={failed} label="Items discussed" value={compact(k?.items ?? 0)} />
        <StatTile size="md" loading={!k && !failed} error={failed} label="People commenting" value={compact(k?.people ?? 0)} />
        <StatTile size="md" loading={!k && !failed} error={failed} label="First reply" value={duration(k?.median_first_reply_s ?? null)} caption="Typical, threads started in the range" />
        <StatTile size="md" loading={!k && !failed} error={failed} label="AI answers" value={compact(k?.ai_answers ?? 0)} caption="@AI replies in threads" />
      </div>
      {data && data.top_items.length > 0 && (
        <ol className="mt-3 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label="Most discussed items">
          {data.top_items.slice(0, 5).map((t) => (
            <li key={t.slug ?? t.title ?? ""} className="flex items-center gap-2">
              {t.slug ? <Anchor href={`/${t.slug}`} className="ph-sensitive ph-mask min-w-0 flex-1 truncate">{t.title || t.slug}</Anchor>
                : <span className="min-w-0 flex-1 truncate">{t.title}</span>}
              <span className="text-caption text-text-muted tabular-nums">{t.threads} threads · {t.open} open · {t.messages} messages</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default AdminComments;
