/**
 * Comments in a printed (PDF) export (Track C). After PrintPages has drawn a page, this puts a numbered marker
 * after the words each thread is about (found in the rendered text, whitespace-insensitive), on its block (by
 * id) when the words aren't found, or after the title for a page comment; then the notes:
 *
 *   margin     each note floats in the right margin beside its block (the page column narrows to make room),
 *              unplaced ones in a list at the end;
 *   footnotes  every note in a numbered list at the end of the page.
 *
 * Pure DOM, on the print layer only (never the live page). Text comes from the server's export endpoint, so
 * only someone who can see the comments gets them.
 */
import type { ExportThreadDto } from "@/lib/commentsInsights";

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figure, pre, .pb-callout, .md-alert, details";

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The text node + offset where the needle (normalised) ends inside root, or null. */
function findEnd(root: HTMLElement, needle: string): { node: Text; offset: number } | null {
  const want = norm(needle);
  if (!want) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest(".pbx-cnote, .pbx-cmark, .pbx-cnotes, script, style")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  // Normalised text with, for each of its characters, where it came from.
  let text = "";
  const map: Array<{ node: Text; offset: number }> = [];
  let lastSpace = true;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const v = n.data;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i]!;
      if (/\s/.test(ch)) {
        if (lastSpace) continue;
        text += " ";
        lastSpace = true;
      } else {
        text += ch;
        lastSpace = false;
      }
      map.push({ node: n, offset: i });
    }
  }
  const at = text.indexOf(want);
  if (at < 0) return null;
  const last = map[at + want.length - 1];
  return last ? { node: last.node, offset: last.offset + 1 } : null;
}

function marker(n: number, id: string): HTMLElement {
  const sup = document.createElement("sup");
  sup.className = "pbx-cmark";
  sup.textContent = String(n);
  sup.setAttribute("data-thread", id);
  return sup;
}

function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function note(t: ExportThreadDto, tag: "aside" | "li"): HTMLElement {
  const el = document.createElement(tag);
  el.className = tag === "aside" ? "pbx-cnote" : "pbx-cnote-item";
  el.setAttribute("data-thread", t.id);
  const head = document.createElement("div");
  head.className = "pbx-cnote__head";
  const num = document.createElement("span");
  num.className = "pbx-cnote__n";
  num.textContent = String(t.n);
  head.append(num);
  const about = document.createElement("span");
  about.className = "pbx-cnote__about";
  about.textContent = t.anchor_type === "page" ? "On the whole page" : t.quote ? `On “${t.quote.length > 120 ? t.quote.slice(0, 119) + "…" : t.quote}”` : "";
  head.append(about);
  if (t.status === "resolved") {
    const st = document.createElement("span");
    st.className = "pbx-cnote__state";
    st.textContent = t.resolved_by ? `Resolved by ${t.resolved_by}` : "Resolved";
    head.append(st);
  }
  el.append(head);
  for (const m of t.messages) {
    const p = document.createElement("p");
    p.className = "pbx-cnote__msg";
    const who = document.createElement("strong");
    who.textContent = `${m.author}${m.ai ? " (AI)" : ""}`;
    const when = document.createElement("span");
    when.className = "pbx-cnote__when";
    when.textContent = ` · ${day(m.at)}`;
    p.append(who, when, document.createElement("br"), document.createTextNode(m.body));
    el.append(p);
  }
  if (t.suggestion) {
    const p = document.createElement("p");
    p.className = "pbx-cnote__msg";
    p.textContent = `Suggested edit: “${t.suggestion}”`;
    el.append(p);
  }
  return el;
}

/** Decorate one printed page (its section element). Returns how many threads were placed in the text. */
export function decoratePrint(section: HTMLElement, threads: ExportThreadDto[], style: "margin" | "footnotes"): number {
  const body = (section.querySelector(".pb-body, .pb-root") as HTMLElement | null) ?? section;
  const title = section.querySelector(".pb-title") as HTMLElement | null;
  section.classList.add("pbx-has-comments", style === "margin" ? "pbx-comments-margin" : "pbx-comments-end");
  const unplaced: ExportThreadDto[] = [];
  let placed = 0;
  for (const t of threads) {
    let host: HTMLElement | null = null;
    const mark = marker(t.n, t.id);
    if (t.anchor_type === "page") {
      if (title) {
        title.append(mark);
        host = title;
      }
    } else {
      const end = t.anchor_type === "text" && t.quote ? findEnd(body, t.quote) : null;
      if (end) {
        const after = end.node.splitText(end.offset);
        after.parentNode?.insertBefore(mark, after);
        host = (mark.parentElement?.closest(BLOCKS) as HTMLElement | null) ?? mark.parentElement;
      } else if (t.block_id) {
        const b = body.querySelector(`#${CSS.escape(t.block_id)}`) as HTMLElement | null;
        if (b) {
          b.append(mark);
          host = b;
        }
      }
      if (!host && t.quote) {
        const end2 = findEnd(body, t.quote.slice(0, 60));
        if (end2) {
          const after = end2.node.splitText(end2.offset);
          after.parentNode?.insertBefore(mark, after);
          host = (mark.parentElement?.closest(BLOCKS) as HTMLElement | null) ?? mark.parentElement;
        }
      }
    }
    if (!host) {
      unplaced.push(t);
      continue;
    }
    placed++;
    if (style === "margin") {
      // A comment on the whole page sits at the top of the body's margin (the title has no margin column).
      const at = t.anchor_type === "page" || !body.contains(host) ? body : host;
      at.insertBefore(note(t, "aside"), at.firstChild);
    }
  }
  const listed = style === "margin" ? unplaced : threads;
  if (listed.length) {
    const box = document.createElement("section");
    box.className = "pbx-cnotes";
    const h = document.createElement("h2");
    h.textContent = style !== "margin" ? "Comments" : listed.every((t) => t.changed) ? "Comments on text that changed" : "More comments";
    const ol = document.createElement("ol");
    ol.className = "pbx-cnotes__list";
    for (const t of listed) ol.append(note(t, "li"));
    box.append(h, ol);
    body.append(box);
  }
  return placed;
}
