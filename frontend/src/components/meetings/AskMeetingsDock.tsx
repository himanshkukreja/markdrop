"use client";

/**
 * Ask your meetings, from the Meetings hub: a launcher (a question box and starter chips) that opens Ask
 * Markdrop (components/assistant) on the Meetings scope of this workspace — the one assistant, with its
 * series / period chips, sources and "jump to the moment". ⌘J opens it too; ?ask=1 opens it on arrival.
 */
import { useEffect } from "react";
import { Icon } from "@/components/ui";
import { openAssistant, useAssistant } from "@/components/assistant/store";
import { loadAssistantPanel } from "@/components/assistant/AssistantRoot";
import { starters } from "@/components/assistant/assistantCore.mjs";

const STARTERS = starters("meetings", null);

export function AskMeetingsDock({ aiMessage, count }: {  /** Why AI is off here (null: on). */
  aiMessage: string | null;
  count: number;
}) {
  const { open } = useAssistant();
  const show = (question?: string) => openAssistant({ scope: "meetings", question });
  // ?ask=1 opens it (links from elsewhere).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("ask") === "1") openAssistant({ scope: "meetings" });
  }, []);

  return (
    <section className="mt-asklaunch" aria-label="Ask your meetings" data-testid="ask-across">
      <button type="button" className="mt-asklaunch__box" onClick={() => show()} aria-haspopup="dialog" aria-expanded={open}
        onPointerEnter={() => void loadAssistantPanel().catch(() => {})} data-testid="ask-across-open">
        <span className="mt-asklaunch__glyph" aria-hidden><Icon name="sparkle" /></span>
        <span className="mt-asklaunch__text">
          <span className="mt-asklaunch__ph">Ask anything about {count === 1 ? "this meeting" : `your ${count} meetings`}…</span>
          <span className="mt-asklaunch__hint">{aiMessage ?? "Decisions, owners, blockers — with links to the moment it was said"}</span>
        </span>
        <span className="mt-asklaunch__go" aria-hidden><Icon name="arrowUp" /></span>
      </button>
      <div className="mt-asklaunch__chips" role="group" aria-label="Suggested questions">
        {STARTERS.map((s) => (
          <button key={s.q} type="button" className="mt-asklaunch__chip" onClick={() => show(s.q)}>
            <Icon name={s.icon ?? "message"} /><span>{s.q}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default AskMeetingsDock;
