"use client";

/**
 * Phones (Mobile board): an item's ⋯ opens a bottom sheet with its actions as 48px rows. The DS
 * Drawer (side="bottom") gives it the modal semantics: focus moves in, Tab stays inside, Escape and
 * the scrim close it, and focus returns to the ⋯ that opened it.
 */
import { Drawer, Icon, cx } from "@/components/ui";

export interface SheetAction {
  label: string;
  icon: string;
  /** Quiet value on the right ("Acme team", "Guides"). */
  value?: string;
  danger?: boolean;
  onClick: () => void;
}

export default function ItemSheet({
  open, onClose, title, address, actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  address?: string | null;
  actions: SheetAction[];
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      title={<span className="block truncate" dir="auto">{title}</span>}
      description={address ? <span className="block truncate font-mono">{address}</span> : undefined}
      bodyClassName="px-2 pt-1 pb-6"
    >
      <ul className="m-0 flex list-none flex-col p-0">
        {actions.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              className={cx(
                "md-focus flex min-h-12 w-full cursor-pointer items-center gap-3.5 rounded-lg bg-transparent px-3 text-left text-body hover:bg-surface-hover",
                a.danger ? "text-danger" : "text-text",
              )}
              onClick={() => { onClose(); a.onClick(); }}
            >
              <Icon name={a.icon} size={18} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {a.value && <span className="max-w-[45%] shrink-0 truncate text-[13px] text-text-muted">{a.value}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
