"use client";

import { useState } from "react";
import { Icon } from "@/components/landing/orbit/ds";
import { guideEvents } from "@/lib/guidesEvents";
import s from "./FixListDemo.module.css";

/**
 * The hero's Fix list card: a small, working copy of the studio's Fix list (fictional Acme data,
 * the same items as the docs screenshots). Pick an item to see its evidence, Draft a fix, then
 * Accept and publish: the item is marked fixed. Server-rendered in its first state (the top item
 * open), so it reads the same before and without JavaScript; nothing moves on its own.
 */

type Stage = "open" | "drafted" | "fixed";
type Item = {
  id: string;
  kind: string;
  icon: string;
  title: string;
  impact: "High impact" | "Medium";
  count: string;
  evidence: { lead: string; bars: Array<{ label: string; value: number; note?: string; hot?: boolean }> };
  action: string;
  fix: { summary: string; where: string; lines: Array<{ t: string; add?: boolean }> };
};

const ITEMS: Item[] = [
  {
    id: "drop",
    kind: "Readers leave here",
    icon: "arrowDown",
    title: "Readers leave at “Install the CLI”",
    impact: "High impact",
    count: "131 readers left here",
    evidence: {
      lead: "Of 310 measured readers, 42% stopped at this section. Elsewhere on the page about 4% stop per section.",
      bars: [
        { label: "Before you start", value: 95 },
        { label: "Install the CLI", value: 92, note: "42% left here", hot: true },
        { label: "Create a project", value: 49 },
        { label: "End of page", value: 31 },
      ],
    },
    action: "Rewrite the section",
    fix: {
      summary: "Adds a one-line intro and a “check it worked” step, so readers know when to move on.",
      where: "Quickstart › Install the CLI",
      lines: [
        { t: "## Install the CLI" },
        { t: "Pick your system, run one command, then check it worked.", add: true },
        { t: "brew install acme/tap/acme" },
        { t: "### Check it worked", add: true },
        { t: "Run `acme --version`. You should see 2.4 or later.", add: true },
      ],
    },
  },
  {
    id: "search",
    kind: "Searches with no results",
    icon: "search",
    title: "Readers search for “proxy” and find nothing",
    impact: "Medium",
    count: "48 searches",
    evidence: {
      lead: "Three wordings that mean the same thing, grouped together, in the last 30 days.",
      bars: [
        { label: "proxy", value: 100, note: "21" },
        { label: "behind a proxy", value: 71, note: "15" },
        { label: "http_proxy", value: 57, note: "12" },
      ],
    },
    action: "Write an answer",
    fix: {
      summary: "Adds a section that answers what readers searched for, at the end of the page that fits.",
      where: "Install the CLI › new section",
      lines: [
        { t: "## Behind a proxy", add: true },
        { t: "Set HTTPS_PROXY before you sign in:", add: true },
        { t: "export HTTPS_PROXY=http://proxy.acme.internal:8080", add: true },
        { t: "Then run `acme login` again.", add: true },
      ],
    },
  },
  {
    id: "video",
    kind: "Video drop-off",
    icon: "film",
    title: "“Product tour” loses most viewers at 0:40",
    impact: "Medium",
    count: "59 viewers lost",
    evidence: {
      lead: "Played 152 times. 39% of viewers stop around 0:40 of 1:40.",
      bars: [
        { label: "0:00", value: 100 },
        { label: "0:20", value: 88 },
        { label: "0:40", value: 49, note: "most stop here", hot: true },
        { label: "1:20", value: 41 },
      ],
    },
    action: "Suggest a fix",
    fix: {
      summary: "Adds chapters, so viewers can skip to the part they came for.",
      where: "What is Acme? › Product tour",
      lines: [
        { t: "::video{id=\"product-tour\"}" },
        { t: "0:00 Sign in", add: true },
        { t: "0:40 Connect a source", add: true },
        { t: "1:10 Share a dashboard", add: true },
      ],
    },
  },
];

export default function FixListDemo() {
  const [openId, setOpenId] = useState(ITEMS[0]!.id);
  const [stages, setStages] = useState<Record<string, Stage>>({});
  const stageOf = (id: string): Stage => stages[id] ?? "open";
  const setStage = (id: string, st: Stage) => setStages((m) => ({ ...m, [id]: st }));
  const left = ITEMS.filter((i) => stageOf(i.id) !== "fixed").length;
  const item = ITEMS.find((i) => i.id === openId)!;
  const stage = stageOf(item.id);

  return (
    <div className={s.card} role="group" aria-label="A working sample of the Fix list (fictional data)">
      <div className={s.head}>
        <span className={s.title}>
          <Icon name="checkSquare" size={15} />
          Fix list
          <span className={s.site}>Acme Docs</span>
        </span>
        <span className={s.count} aria-live="polite">{left === 0 ? "All fixed" : `${left} to fix`}</span>
      </div>

      <ul className={s.list}>
        {ITEMS.map((it, n) => {
          const st = stageOf(it.id);
          const open = it.id === openId;
          return (
            <li key={it.id} className={s.row} data-open={open || undefined} data-fixed={st === "fixed" || undefined}>
              <button
                type="button"
                className={s.rowBtn}
                aria-expanded={open}
                aria-controls={open ? "fixdemo-panel" : undefined}
                onClick={() => {
                  setOpenId(it.id);
                  if (!open) guideEvents.landingDemo("item");
                }}
              >
                <span className={s.rank} aria-hidden>{n + 1}</span>
                <span className={s.ico} data-kind={it.id} aria-hidden><Icon name={st === "fixed" ? "check" : it.icon} size={14} /></span>
                <span className={s.rowText}>
                  <span className={s.kind}>{it.kind}</span>
                  <span className={s.rowTitle}>{it.title}</span>
                </span>
                <span className={s.rowMeta}>
                  {st === "fixed" ? (
                    <span className={s.fixedTag}>Fixed</span>
                  ) : (
                    <span className={s.impact} data-high={it.impact === "High impact" || undefined}>{it.impact}</span>
                  )}
                  <span className={s.affected}>{it.count}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div id="fixdemo-panel" className={s.panel}>
        <p className={s.lead}>{item.evidence.lead}</p>
        <div className={s.bars}>
          {item.evidence.bars.map((b) => (
            <div key={b.label} className={s.bar} data-hot={b.hot || undefined}>
              <span className={s.barLabel}>{b.label}</span>
              <span className={s.barNote}>{b.note ?? `${b.value}%`}</span>
              <span className={s.track} aria-hidden><span style={{ width: `${b.value}%` }} /></span>
            </div>
          ))}
        </div>

        {stage === "open" && (
          <div className={s.actions}>
            <button
              type="button"
              className={`md-btn md-btn--md ${s.primary}`}
              onClick={() => {
                setStage(item.id, "drafted");
                guideEvents.landingDemo("drafted");
              }}
            >
              <Icon name="sparkle" size={15} />
              Draft a fix: {item.action.toLowerCase()}
            </button>
          </div>
        )}

        {stage !== "open" && (
          <div className={s.fix} data-fixed={stage === "fixed" || undefined}>
            <p className={s.fixH}><Icon name="sparkle" size={14} />Suggested fix</p>
            <p className={s.fixSum}>{item.fix.summary}</p>
            <pre className={s.diff} aria-label={`Change to ${item.fix.where}`}>
              {item.fix.lines.map((l, i) => (
                <span key={i} className={l.add ? s.add : undefined}>
                  <i aria-hidden>{l.add ? "+" : " "}</i>
                  {l.add && <span className="sr-only">Added: </span>}
                  {l.t}
                  {"\n"}
                </span>
              ))}
            </pre>
            {stage === "drafted" ? (
              <div className={s.actions}>
                <button
                  type="button"
                  className={`md-btn md-btn--md ${s.primary}`}
                  onClick={() => {
                    setStage(item.id, "fixed");
                    guideEvents.landingDemo("published");
                    const next = ITEMS.find((i) => i.id !== item.id && stageOf(i.id) !== "fixed");
                    if (next) window.setTimeout(() => setOpenId(next.id), 1400);
                  }}
                >
                  <Icon name="send" size={15} />
                  Accept and publish
                </button>
                <span className={s.hint}>Opens as a suggestion in the editor. Nothing goes live until you publish.</span>
              </div>
            ) : (
              <p className={s.done} role="status">
                <Icon name="checkCircle" size={15} />
                Published and marked fixed. It comes back if readers still struggle.
              </p>
            )}
          </div>
        )}
      </div>
      {left === 0 && (
        <button type="button" className={s.reset} onClick={() => { setStages({}); setOpenId(ITEMS[0]!.id); }}>
          <Icon name="rotate" size={13} />
          Start the sample again
        </button>
      )}
    </div>
  );
}
