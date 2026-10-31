"use client";

import { useState } from "react";
import { Button, Textarea } from "@/components/ui";
import { useDocPage } from "./page";
import { useDocsSite } from "./site";
import { AskAboutPageButton } from "./ask/entry";

/**
 * "Did this page help?" Sends {path, helpful, comment?} to the site's feedback endpoint and thanks
 * the reader whatever happens: feedback must never show an error or block reading. A site without a
 * feedback endpoint (site.json `feedback`: a Markdrop Guides site has one while its owner keeps
 * Insights on) doesn't ask, since nobody would receive the answer: its row only offers Ask AI, and is
 * left out when Ask AI is off too. A guide's Insights keeps comments up to 1,000 characters.
 */
function send(url: string | undefined, body: { path: string; helpful: boolean; comment?: string }) {
  if (!url) return;
  try {
    void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  } catch {
    /* never surfaces */
  }
}

export function Feedback() {
  const page = useDocPage();
  const { ai, insights } = useDocsSite();
  const [state, setState] = useState<"ask" | "comment" | "done">("ask");
  const [comment, setComment] = useState("");
  if (!page) return null;
  if (!page.feedbackUrl)
    return ai ? (
      <div className="dx-feedback">
        <span className="dx-feedback__q">Still have a question?</span>
        <AskAboutPageButton variant="ghost" />
      </div>
    ) : null;
  if (state === "done")
    return (
      <div className="dx-feedback" role="status">
        <span className="dx-feedback__q">Thanks. It helps us decide what to fix next.</span>
      </div>
    );
  if (state === "comment")
    return (
      <form
        className="dx-feedback dx-feedback--form"
        onSubmit={(e) => {
          e.preventDefault();
          send(page.feedbackUrl, { path: page.path, helpful: false, comment: comment.trim() || undefined });
          setState("done");
        }}
      >
        <label htmlFor="dx-fb" className="dx-feedback__q">
          What was missing or wrong?
        </label>
        <Textarea id="dx-fb" rows={3} maxLength={insights ? 1000 : 2000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional. Don't include passwords or keys." />
        <div className="dx-feedback__row">
          <Button type="submit" size="sm">
            Send feedback
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              send(page.feedbackUrl, { path: page.path, helpful: false });
              setState("done");
            }}
          >
            Skip
          </Button>
        </div>
      </form>
    );
  return (
    <div className="dx-feedback">
      <span className="dx-feedback__q">Did this page help?</span>
      <Button
        variant="secondary"
        size="sm"
        iconLeft="check"
        onClick={() => {
          send(page.feedbackUrl, { path: page.path, helpful: true });
          setState("done");
        }}
      >
        Yes
      </Button>
      <Button variant="secondary" size="sm" iconLeft="x" onClick={() => setState("comment")}>
        Not quite
      </Button>
      <AskAboutPageButton variant="ghost" />
    </div>
  );
}
