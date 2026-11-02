"use client";

import { useState, type CSSProperties } from "react";
import { guideEvents } from "@/lib/guidesEvents";
import h from "./DropHero.module.css";

/**
 * The hero's Fix list card (a sample, fictional Acme data): three items, the chosen one's drafted
 * fix, and "Open in editor", which turns into "In progress · fixed when you publish" (docs:
 * guides/fix-list "Draft a fix"). Counted as guide_landing_demo {step: item | drafted}.
 */

const ITEMS = [
  {
    id: "leave",
    color: "var(--danger-fill)",
    title: "Readers leave at “Install the CLI”",
    why: "42% of 310 readers · High impact",
    action: "Rewrite the section",
    draft: "Install it, then sign in:\n  npm install -g @acme/cli\n  acme login",
  },
  {
    id: "agents",
    color: "var(--accent)",
    title: "Agents find nothing: “terraform”",
    why: "23 MCP searches · AI agents",
    action: "Write an answer",
    draft: "## Terraform\nNo provider yet; use the API:\nsee API reference › Projects.",
  },
  {
    id: "sso",
    color: "var(--warning-fill)",
    title: "“sso” finds nothing",
    why: "18 searches · Medium impact",
    action: "Write an answer",
    draft: "## Single sign-on\nYour admin turns it on under\nSettings › Security.",
  },
] as const;

type Id = (typeof ITEMS)[number]["id"];

export default function HeroFixList() {
  const [item, setItem] = useState<Id>("leave");
  const [accepted, setAccepted] = useState(false);
  const cur = ITEMS.find((i) => i.id === item) ?? ITEMS[0];

  const pick = (id: Id) => {
    if (id !== item) {
      setItem(id);
      setAccepted(false);
    }
    guideEvents.landingDemo("item");
  };

  return (
    <div className={h.fix} role="group" aria-labelledby="hero-fix-title">
      <div className={h.fixHead}>
        <span id="hero-fix-title">Fix list</span>
        <span className={h.fixCount}>15 to fix</span>
      </div>
      {ITEMS.map((it, n) => (
        <button
          key={it.id}
          type="button"
          className={h.item}
          data-on={it.id === item || undefined}
          data-new={n === 0 && it.id !== item ? "" : undefined}
          aria-pressed={it.id === item}
          onClick={() => pick(it.id)}
          style={{ "--ic": it.color } as CSSProperties}
        >
          <i aria-hidden="true" />
          <span>
            <b>{it.title}</b>
            <small>{it.why}</small>
          </span>
        </button>
      ))}
      <div className={h.draft} aria-live="polite">
        <b>{cur.action}</b>
        <pre>{cur.draft}</pre>
        <div className={h.draftFoot}>
          {accepted ? (
            <span className={h.ok}>In progress · fixed when you publish</span>
          ) : (
            <button
              type="button"
              className={h.mini}
              onClick={() => {
                setAccepted(true);
                guideEvents.landingDemo("drafted");
              }}
            >
              Open in editor
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
