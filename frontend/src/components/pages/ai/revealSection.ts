/**
 * An answer's section link → scroll to that heading and flash it.
 *
 * The reader's headings carry ids (`user-content-<slug>`); the editor's don't, so there the
 * heading is found by the slug of its text, in page order (lib/pages-ai/ask-core `matchHeading`).
 * A `#b-…` block anchor works too. Returns false when the section isn't on the page.
 */
import { idCandidates, matchHeading } from "@/lib/pages-ai/ask-core";

const HEADINGS = "h1, h2, h3, h4";

function pageRoots(): HTMLElement[] {
  // The live editor first (it replaces the server-rendered page once it's ready), then the reader.
  const roots = [...document.querySelectorAll<HTMLElement>(".pb-live .ProseMirror, .pb-paper .pb-page")];
  return roots.filter((r) => r.offsetParent !== null || r.getClientRects().length > 0);
}

export function findSection(id: string): HTMLElement | null {
  const roots = pageRoots();
  const inPage = (el: Element | null): el is HTMLElement => !!el && roots.some((r) => r.contains(el)) && (el as HTMLElement).getClientRects().length > 0;
  for (const c of idCandidates(id)) {
    const el = document.getElementById(c);
    if (inPage(el)) return el;
  }
  if (/^b-[a-z0-9]{4,12}$/.test(id)) {
    for (const r of roots) {
      const el = r.querySelector<HTMLElement>(`[data-bid="${CSS.escape(id)}"]`);
      if (el) return el;
    }
  }
  for (const r of roots) {
    const hs = [...r.querySelectorAll<HTMLElement>(HEADINGS)].filter((h) => !h.closest(".pa-ask"));
    const i = matchHeading(hs.map((h) => h.textContent ?? ""), id);
    if (i >= 0) return hs[i];
  }
  return null;
}

export function revealSection(id: string): boolean {
  const el = findSection(id);
  if (!el) return false;
  // A heading inside a closed toggle: open it first.
  for (let p = el.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement && !p.open) p.open = true;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  if (el.closest(".ProseMirror")) flashOver(el);
  else {
    el.classList.remove("pa-flash");
    void el.offsetWidth;
    el.classList.add("pa-flash");
    window.setTimeout(() => el.classList.remove("pa-flash"), 2400);
  }
  return true;
}

/**
 * The editor owns its DOM (ProseMirror redraws a node whose attributes change), so there the
 * flash is a box laid over the heading instead of a class on it. It sits in the document, so it
 * stays put while the page scrolls to it.
 */
function flashOver(el: HTMLElement) {
  document.querySelectorAll(".pa-flash-box").forEach((b) => b.remove());
  const r = el.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "pa-flash-box pa-flash";
  box.dataset.for = el.textContent?.trim().slice(0, 80) ?? "";
  Object.assign(box.style, {
    position: "absolute",
    left: `${r.left + window.scrollX - 6}px`,
    top: `${r.top + window.scrollY - 4}px`,
    width: `${r.width + 12}px`,
    height: `${r.height + 8}px`,
    pointerEvents: "none",
    zIndex: "1",
  });
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 2400);
}
