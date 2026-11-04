"use client";

/**
 * The page's sign-offs under its title (with its other properties): one pill each — the label and
 * where it stands ("Waiting for Riya", "Approved for production · Riya"), coloured by the decision.
 * A click scrolls to the block. Nothing when the page has none.
 */
import { useSyncExternalStore } from "react";
import { Icon } from "@/components/ui";
import { signoffStore, type SignoffStore } from "./store";
import "./signoff.css";

const noop = () => () => {};

/** `store`, or the page's own (`slug`: the reader's page fills it). */
export function SignoffSummary({ store: given, slug }: { store?: SignoffStore | null; slug?: string }) {
  const store = given ?? (slug ? signoffStore(slug) : null);
  useSyncExternalStore(store?.subscribe ?? noop, () => store?.version ?? 0, () => 0);
  const list = store?.all() ?? [];
  if (!list.length) return null;
  const jump = (id: string) => {
    const el = document.querySelector<HTMLElement>(`.pb-live [data-signoff="${id}"], [data-signoff="${id}"]`);
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  };
  return (
    <div className="pb-signoff-summary no-print" aria-label="Sign-offs">
      {list.map((s) => {
        const who = s.signed_by?.name || s.person?.name;
        const state = s.option ? `${s.option}${who ? ` · ${who}` : ""}` : s.can_sign ? "Waiting for you" : who ? `Waiting for ${who}` : "Waiting";
        return (
          <button key={s.block} type="button" className={`pb-signoff-pill${s.option ? ` pb-signoff-pill--${s.tone ?? "neutral"}` : ""}`} onClick={() => jump(s.block)} title={`${s.label}: ${state}`}>
            {s.option ? <span className="pb-signoff-pill__dot" aria-hidden /> : <Icon name="clock" size={12} aria-hidden />}
            <span className="pb-signoff-pill__label">{s.label}</span>
            <span className="pb-signoff-pill__state ph-mask">{state}</span>
            {s.option && s.lock === "above" && <Icon name="lock" size={11} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
