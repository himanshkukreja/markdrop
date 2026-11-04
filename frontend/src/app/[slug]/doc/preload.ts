/**
 * The code a view needs before it can paint (fix/open-flash). A gated item's kind is known only once
 * the signed-in read answers, and a page's chrome or a file's viewer loads on demand; rendering it
 * before that code is here paints an empty screen between the opening cover and the item. The
 * viewer starts these as soon as it knows (the listing's hint, or the read) and keeps the cover up
 * until they're in. Each is the same module the view's dynamic() import loads.
 */
import type { OpeningKind } from "@/lib/opening";
import type ArtifactViewComponent from "../ArtifactView";

/** Modules already here, to render directly: a dynamic() component suspends on its first render
 *  even when its code is loaded, and the page's Suspense fallback would flash in its place (and
 *  React holds a fallback on screen for 300 ms). */
export const ready: { ArtifactView: typeof ArtifactViewComponent | null } = { ArtifactView: null };

const once = new Map<string, Promise<unknown>>();
const load = (key: string, f: () => Promise<unknown>) => {
  let p = once.get(key);
  if (!p) {
    p = f().catch(() => undefined); // a failed chunk is the view's to report, not the read's
    once.set(key, p);
  }
  return p;
};

export function preloadView(kind: OpeningKind | "any" | null | undefined): Promise<unknown> {
  if (kind === "file") return load("file", () => import("../ArtifactView").then((m) => { ready.ArtifactView = m.default; }));
  if (kind === "page") {
    return load("page", () => Promise.all([
      import("@/components/pages/PageChrome"),
      import("@/components/pages/PageRenderer"),
    ]));
  }
  return Promise.resolve();
}

/** The kind of a document the API returned. */
export function viewKindOf(doc: { kind?: string | null; editor?: string | null }): OpeningKind {
  return doc.kind === "artifact" ? "file" : doc.editor === "blocks" ? "page" : "doc";
}
