"use client";

/**
 * ⌘K's Ask AI mode (board "Search", ask state): one short streamed answer with numbered source
 * pills, and "Continue in panel" to keep asking in the Ask AI panel. Loaded the first time the
 * reader switches to Ask AI.
 */
import { Button, Icon, IconButton, copyText, useToast } from "@/components/ui";
import { openSearch } from "../state";
import { answerForCopy } from "./Answer";
import { OpenInLinks, TurnView, fallbackOpenIn } from "./Conversation";
import { claudeHref, continueInPanel, isStreaming, useAsk } from "./store";

export default function PaletteAsk({ suggestions, onAsk, onContinued, onNavigate }: { suggestions: string[]; onAsk: (q: string) => void; onContinued: () => void; onNavigate: () => void }) {
  const s = useAsk();
  const toasts = useToast();
  const turn = s.palette.turns[s.palette.turns.length - 1];

  if (s.availability === "unavailable" && !turn) {
    return (
      <div className="dx-palask dx-palask--off" role="status">
        <p>
          {s.unavailableReason === "not_configured"
            ? "Ask AI isn't set up on this server yet. Search the docs instead, or open them in your own assistant."
            : "Ask AI is turned off right now. Search the docs instead, or open them in your own assistant."}
        </p>
        <OpenInLinks links={fallbackOpenIn("", s.page, s.siteUrl)} />
        <Button variant="ghost" size="sm" iconLeft="search" onClick={() => openSearch()}>
          Back to search
        </Button>
      </div>
    );
  }

  if (!turn) {
    return (
      <div className="dx-palask">
        <p className="dx-palask__intro">Ask a question in your own words. The answer comes from these docs, with links to the sections it used{s.page ? `, and knows you're reading “${s.page.title}”` : ""}.</p>
        {suggestions.length > 0 && (
          <div className="dx-palette__group">
            <div className="dx-palette__grouphead">
              <span className="dx-eyebrow">Try</span>
            </div>
            {suggestions.slice(0, 5).map((q) => (
              <button key={q} type="button" className="dx-palette__row dx-palette__row--btn" onClick={() => onAsk(q)}>
                <Icon name="zap" className="dx-palette__icon" />
                <span className="dx-palette__main">
                  <span className="dx-palette__title">{q}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const streaming = isStreaming(turn);
  return (
    <div className="dx-palask">
      <TurnView
        turn={turn}
        variant="palette"
        siteUrl={s.siteUrl}
        onNavigate={onNavigate}
        actions={
          (turn.state === "done" || streaming || turn.state === "stopped") && (
            <div className="dx-palask__actions">
              <Button
                size="sm"
                variant="primary"
                iconRight="arrowRight"
                onClick={() => {
                  continueInPanel();
                  onContinued();
                }}
              >
                Continue in panel
              </Button>
              {turn.state === "done" && turn.answer && (
                <>
                  <IconButton
                    icon="copy"
                    label="Copy answer"
                    size="sm"
                    onClick={async () => {
                      if (await copyText(answerForCopy(turn.answer, turn.sources))) toasts.success("Answer copied");
                    }}
                  />
                  <Button href={claudeHref(turn.question, turn.ctx, s.siteUrl)} target="_blank" variant="ghost" size="sm" iconRight="external">
                    Continue in Claude
                  </Button>
                </>
              )}
            </div>
          )
        }
      />
      <div className="dx-sr" aria-live="polite" aria-atomic="true">
        {streaming ? turn.status?.label ?? "Answering" : turn.state === "done" ? "Answer ready." : ""}
      </div>
    </div>
  );
}
