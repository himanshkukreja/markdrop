"use client";

/**
 * View mode / Edit mode for a page (DocumentView): the bar's "Edit" in View mode (E) and "Done" in
 * the editor. Phones get the icon alone (the bar keeps its room for the title); on touch screens
 * it's a 44 px target (pages.css). `data-page-mode` lets the other mode's button take the focus
 * when the bar swaps (Edit → Done, Done → Edit).
 */
import { Button, IconButton, Kbd, Tooltip } from "@/components/ui";
import { useShortcutsEnabled } from "@/lib/shortcuts";
import { usePhone } from "./PageChrome";

export function PageModeButton({ mode, onClick, busy = false }: { mode: "edit" | "done"; onClick: () => void; busy?: boolean }) {
  const phone = usePhone();
  const [shortcuts] = useShortcutsEnabled();
  if (mode === "done") {
    return phone ? (
      <IconButton icon="check" label="Done editing" size="sm" variant="ghost" className="pb-bar__btn pb-mode" data-page-mode="done" loading={busy} onClick={onClick} />
    ) : (
      <Button variant="secondary" size="sm" iconLeft="check" className="pb-bar__btn pb-mode" data-page-mode="done" loading={busy} onClick={onClick} title="Back to reading">
        Done
      </Button>
    );
  }
  const keys = shortcuts !== false ? "E" : undefined;
  return phone ? (
    <IconButton icon="edit" label="Edit" size="sm" variant="ghost" className="pb-bar__btn pb-mode" data-page-mode="edit" aria-keyshortcuts={keys} loading={busy} onClick={onClick} />
  ) : (
    <Tooltip side="bottom" content={<span className="inline-flex items-center gap-1.5">Edit this page{keys && <> <Kbd>E</Kbd></>}</span>}>
      <Button variant="ghost" size="sm" iconLeft="edit" className="pb-bar__btn pb-mode" data-page-mode="edit" aria-label="Edit" aria-keyshortcuts={keys} loading={busy} onClick={onClick}>
        <span className="pb-bar__label">Edit</span>
      </Button>
    </Tooltip>
  );
}

/** Put the focus on the bar's mode button once it's on screen (after Edit or Done swapped the bar). */
export function focusPageMode(which: "edit" | "done", tries = 200) {
  // (The editor's bar is in the DOM, hidden, while the editor loads: focus only takes once it shows.)
  const el = Array.from(document.querySelectorAll<HTMLElement>(`[data-page-mode="${which}"]`)).find((b) => !b.closest("[aria-hidden='true'], .pb-preload"));
  el?.focus({ preventScroll: true });
  if ((!el || document.activeElement !== el) && tries > 0) window.setTimeout(() => focusPageMode(which, tries - 1), 50);
}
