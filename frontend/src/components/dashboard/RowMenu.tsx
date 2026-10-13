"use client";

import { Dropdown, IconButton, type MenuEntry } from "@/components/ui";

/**
 * The overflow menu on a dashboard row: the DS menu button (keyboard, typeahead, Escape returns
 * focus, flips up near the bottom of the viewport). Accepts header rows, which the dashboard uses
 * for the non-interactive status line (badges that didn't fit on the row). The trigger is always
 * visible (never hover-only) and grows to 44px on phones, where it is the row's only action.
 */
export type { MenuEntry, MenuItem } from "@/components/ui";

export default function RowMenu({
  items,
  label = "More actions",
  align = "right",
}: {
  items: MenuEntry[];
  label?: string;
  align?: "left" | "right";
}) {
  return (
    <Dropdown
      align={align}
      minWidth={240}
      aria-label={label}
      trigger={<IconButton icon="more" label={label} size="sm" className="max-sm:size-11" />}
      items={items}
    />
  );
}
