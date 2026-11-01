"use client";

import { useEffect, useState } from "react";
import { Button, ConfirmDialog, Icon, Tooltip, useToast } from "@/components/ui";
import {
  FONTS, docsErrorMessage, getDesignBaseline, presetName, resetDesign, updateSite,
  type DesignBaseline, type Site, type SiteTheme,
} from "@/lib/docsSites";
import { fullCustom, isEmptyCustom } from "@/lib/guideThemes";

const MODE: Record<SiteTheme["mode"], string> = { both: "Light and dark", light: "Light only", dark: "Dark only" };
const CORNERS: Record<string, string> = { sharp: "Sharp", soft: "Soft", round: "Round" };
const font = (id: string | null | undefined) => (id ? FONTS.find((f) => f.id === id)?.label ?? id : "Theme default");

/** "Midnight → Clean" and the like, where a change has a short way to say it. */
function detail(field: string, from: SiteTheme, to: SiteTheme): string | null {
  switch (field) {
    case "preset":
      return `${presetName(from.preset)} → ${presetName(to.preset)}`;
    case "mode":
      return `${MODE[from.mode] ?? from.mode} → ${MODE[to.mode] ?? to.mode}`;
    case "corners":
      return `${from.corners ? CORNERS[from.corners] : "Theme default"} → ${to.corners ? CORNERS[to.corners] : "Theme default"}`;
    case "fonts":
      return ([["heading", "headings"], ["body", "body"], ["mono", "code"]] as const)
        .filter(([k]) => (from.fonts[k] ?? null) !== (to.fonts[k] ?? null))
        .map(([k, word]) => `${word} ${font(from.fonts[k])} → ${font(to.fonts[k])}`)
        .join(", ") || null;
    case "brand_enabled":
      return to.brand.enabled ? "turned back on" : "turned off";
    case "logo":
      return to.brand.logo_url ? "the starting logo comes back" : "removed";
    case "custom":
      return isEmptyCustom(to.custom) ? "removed (the theme as designed)" : "back to the starting one";
    case "custom_css":
      return to.custom_css ? "back to the starting CSS" : "removed";
    default:
      return null;
  }
}

/** Where the starting design comes from, in a phrase ("after its import"). */
function startedWhen(b: DesignBaseline | null): string {
  if (!b) return "started with";
  if (b.how === "default") return "the default design";
  return b.source === "import" ? "had right after its import" : "had when it was created";
}

/**
 * Design › Reset design (admins): the design back to the one the guide started with, after its
 * import or when it was created (services/docs_site_design.py). A warning dialog lists what
 * changes; the reset is saved like "Save design" and published only at the next publish. Undo in
 * the toast saves the design from before the reset back.
 */
export default function DesignReset({ site, saved, dirty, onSite, onReset }: {
  site: Site;
  /** The saved design, as the panel normalises it (what Undo puts back). */
  saved: SiteTheme;
  /** Unsaved changes in the panel: the reset drops them too. */
  dirty: boolean;
  onSite: (next: Site) => void;
  onReset?: () => void;
}) {
  const toast = useToast();
  const [baseline, setBaseline] = useState<DesignBaseline | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const savedKey = JSON.stringify(site.settings.theme);

  // Again whenever the saved design changes (a save, a reset, an undo).
  useEffect(() => {
    let live = true;
    setFailed(false);
    getDesignBaseline(site.id).then((b) => { if (live) setBaseline(b); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [site.id, savedKey]);

  async function undo(prev: SiteTheme) {
    try {
      const back = await updateSite(site.id, { settings: { theme: { ...prev, custom_css: prev.custom_css || null, custom: fullCustom(prev.custom) } } });
      onSite(back);
      toast.success("Design restored");
    } catch (e) {
      toast.error(docsErrorMessage(e, "The design didn't come back. Try again."));
    }
  }

  async function confirm() {
    const prev = saved;
    let next: Awaited<ReturnType<typeof resetDesign>>;
    try {
      next = await resetDesign(site.id);
    } catch (e) {
      throw new Error(docsErrorMessage(e, "The design didn't reset. Try again."));
    }
    const { design, ...fresh } = next;
    onSite(fresh as Site);
    setBaseline(design);
    setOpen(false);
    onReset?.();
    toast.success("Design reset", { duration: 10000, action: { label: "Undo", onClick: () => void undo(prev) } });
  }

  const same = !!baseline?.same;
  const when = startedWhen(baseline);
  const button = (
    <Button variant="secondary" size="sm" iconLeft="history" disabled={!baseline || same} onClick={() => setOpen(true)}>
      Reset design
    </Button>
  );

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-danger-soft text-danger" aria-hidden><Icon name="history" size={18} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-[15px] font-semibold text-text">Reset design</h2>
          <p className="text-[13px] text-text-secondary">
            {baseline?.how === "default"
              ? "Go back to the default design."
              : `Go back to the design this guide ${when}.`}{" "}
            Your saved templates and uploaded logos are kept.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {same
          ? <Tooltip focusable content="Nothing to reset: this is the design the guide started with.">{button}</Tooltip>
          : button}
        {failed && <span className="text-[12px] text-text-muted">Couldn&apos;t check the starting design.</span>}
      </div>

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        title="Reset the design?"
        confirmLabel="Reset design"
        size="md"
        body={baseline && (
          <div className="flex flex-col gap-3 text-[14px] text-text-secondary">
            <p>
              {baseline.how === "default"
                ? <>This puts <strong className="ph-sensitive ph-mask text-text">{site.name}</strong> back on the default design.</>
                : <>This puts back the design <strong className="ph-sensitive ph-mask text-text">{site.name}</strong> {when}.</>}
            </p>
            {baseline.note && <p className="rounded-lg border border-border bg-bg px-3 py-2 text-[13px]">{baseline.note}</p>}
            {baseline.changes.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <strong className="text-[13px] font-semibold text-text">What changes</strong>
                <ul className="flex list-disc flex-col gap-1 pl-5">
                  {baseline.changes.map((c) => {
                    const d = detail(c.field, saved, baseline.theme);
                    return <li key={c.field}><span className="text-text">{c.label}</span>{d ? <span>: {d}</span> : null}</li>;
                  })}
                </ul>
              </div>
            )}
            {dirty && <p>Your unsaved changes are dropped too.</p>}
            <p className="text-[13px]">Saved design templates are kept. Nothing changes for readers until you publish.</p>
          </div>
        )}
      />
    </div>
  );
}
