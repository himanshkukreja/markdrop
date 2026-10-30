"use client";

import { Children, isValidElement, useId, useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui";
import { setSyncedChoice, useSyncedChoice } from "./state";

/**
 * `::::tabs{sync="os"}` with `:::tab[macOS]` children. Every panel is in the HTML (search engines,
 * Copy page, no-JS readers); only the chosen one shows. With `sync`, the choice is remembered and
 * every tab group with the same `sync` on every page follows it.
 */
export function DocsTabs({ labels, sync, children }: { labels?: string; sync?: string; children?: ReactNode }) {
  let list: string[] = [];
  try {
    list = JSON.parse(labels ?? "[]");
  } catch {}
  const panels = Children.toArray(children).filter(isValidElement);
  const stored = useSyncedChoice(sync);
  const [local, setLocal] = useState<string | null>(null);
  const uid = useId().replace(/:/g, "");
  const pick = sync ? stored ?? local : local;
  const active = pick && list.includes(pick) ? pick : list[0];
  if (!list.length) return <>{children}</>;
  return (
    <div className="dx-tabs">
      <Tabs
        items={list.map((l, i) => ({ value: String(i), label: l }))}
        value={String(list.indexOf(active))}
        onChange={(v) => {
          const label = list[+v];
          setLocal(label);
          if (sync) setSyncedChoice(sync, label);
        }}
        variant="line"
        size="sm"
        idPrefix={uid}
        className="dx-tabs__list not-prose"
        aria-label={sync === "os" ? "Your system" : sync === "lang" ? "Language" : sync === "dns" ? "Your DNS provider" : "Options"}
      />
      {panels.map((p, i) => (
        <div
          key={i}
          role="tabpanel"
          id={`${uid}-panel-${i}`}
          aria-labelledby={`${uid}-tab-${i}`}
          className="dx-tabs__panel"
          hidden={list[i] !== active}
        >
          {p}
        </div>
      ))}
    </div>
  );
}
