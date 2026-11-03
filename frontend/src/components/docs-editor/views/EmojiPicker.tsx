"use client";

/**
 * The emoji picker (a page's icon, a callout's icon): search by name or keyword, or browse by
 * group; optional Upload and Remove. Closes on Escape or a click outside. Styles: pages.css
 * (`.pb-emojipick`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button, Icon, Input } from "@/components/ui";
import { EMOJI, searchEmoji, type Emoji } from "../emoji";

const GROUPS: Emoji["g"][] = ["Smileys", "People", "Nature", "Food", "Activity", "Travel", "Objects", "Symbols"];

export function EmojiPicker({ onPick, onRemove, onUpload, onClose, className }: { onPick: (e: string) => void; onRemove?: () => void; onUpload?: (f: File) => void; onClose: () => void; className?: string }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const found = q.trim() ? searchEmoji(q, 120) : null;
  const cell = (em: Emoji) => (
    <button key={`${em.g}${em.n}`} type="button" className="pb-emojipick__cell md-focus" title={`:${em.n}:`} aria-label={em.n.replace(/_/g, " ")} onClick={() => onPick(em.e)}>
      {em.e}
    </button>
  );
  return (
    <div ref={ref} className={["pb-emojipick", className].filter(Boolean).join(" ")} role="dialog" aria-label="Choose an icon" contentEditable={false}>
      <div className="pb-emojipick__top">
        <Input size="sm" iconPrefix="search" placeholder="Search emoji" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search emoji" autoFocus id={id} />
        {onUpload && (
          <label className="pb-emojipick__upload md-focus">
            <Icon name="upload" size={14} /> Upload
            <input type="file" accept="image/*" className="md-visually-hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
          </label>
        )}
        {onRemove && (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <div className="pb-emojipick__grid">
        {found ? (
          found.length ? found.map(cell) : <p className="pb-emojipick__none">No emoji match “{q}”</p>
        ) : (
          GROUPS.map((g) => (
            <section key={g} aria-label={g}>
              <h3 className="pb-emojipick__group">{g}</h3>
              <div className="pb-emojipick__cells">{EMOJI.filter((e) => e.g === g).map(cell)}</div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export default EmojiPicker;
