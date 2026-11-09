"use client";

/** "Comment insights" from the comments panel's ⋯ menu: the item's comment numbers in a dialog. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Dialog, Icon, SegmentedControl } from "@/components/ui";
import type { InsightsRange } from "@/lib/commentsInsights";
import type { CommentsCtx } from "../context";
import { CommentsInsights } from "./CommentsInsights";

export function openInsights(ctx: CommentsCtx): void {
  const host = document.createElement("div");
  host.setAttribute("data-comments-insights-dialog", "");
  document.body.appendChild(host);
  const root = createRoot(host);
  const done = () => {
    window.setTimeout(() => {
      root.unmount();
      host.remove();
    }, 250);
  };
  root.render(<InsightsDialog slug={ctx.slug} onDone={done} />);
}

function InsightsDialog({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [open, setOpen] = useState(true);
  const [range, setRange] = useState<InsightsRange>("30d");
  const close = () => {
    setOpen(false);
    onDone();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Comment insights"
      description="How the discussion on this page is going."
      glyph={<Icon name="chart" />}
      size="lg"
      footer={<Button variant="secondary" onClick={close}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        <SegmentedControl<InsightsRange>
          size="sm"
          aria-label="Period for activity"
          value={range}
          onChange={setRange}
          options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }, { value: "all", label: "All" }]}
        />
        <CommentsInsights slug={slug} range={range} compact />
      </div>
    </Dialog>
  );
}
