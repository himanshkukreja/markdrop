/**
 * MetaList (K2 link & frames kit): key/value metadata as a real `<dl>` (each pair wrapped in a div,
 * which HTML allows). `rows` = key left / value right with hairlines and 44px rows (the viewer details
 * card and its phone sheet); `grid` = key over value in auto-fitting columns. Server-compatible.
 */
import type { ReactNode } from "react";
import styles from "./MetaList.module.css";

export interface MetaItem {
  k: ReactNode;
  v: ReactNode;
  /** Render the value in mono (slugs, hosts, ids). */
  mono?: boolean;
}

export interface MetaListProps {
  items: MetaItem[];
  layout?: "rows" | "grid";
  /** sm = 32px rows and 13px text; md = 44px rows (touch-sized) and 14px. */
  size?: "sm" | "md";
  className?: string;
}

export function MetaList({ items, layout = "rows", size = "md", className }: MetaListProps) {
  return (
    <dl className={[styles.list, className ?? ""].join(" ")} data-layout={layout} data-size={size}>
      {items.map((it, i) => (
        <div key={i} className={styles.item}>
          <dt className={styles.k}>{it.k}</dt>
          <dd className={styles.v} data-mono={it.mono || undefined}>
            {it.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default MetaList;
