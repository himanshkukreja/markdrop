"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Dropdown, Icon, IconButton, type MenuItem } from "@/components/ui";
import { TEMPLATES_BY_ID } from "@/lib/readmeSections";
import { SectionIcon } from "@/lib/readmeSectionIcons";
import type { SectionInstance } from "./model";
import styles from "./builder.module.css";

const EASE = "cubic-bezier(.16,1,.3,1)"; // --ease-out
const FLIP_MS = 200;

export function sectionName(inst: SectionInstance): string {
  return TEMPLATES_BY_ID[inst.templateId]?.name ?? "Section";
}

const INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "To reorder, press Space or Enter on the handle, move with the Up and Down arrow keys, then press Space or Enter to drop. Escape cancels. Move up and Move down are also in each row's menu.",
};

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Props {
  sections: SectionInstance[];
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  /** Reorder: move the section at `from` to `to`. */
  onMove: (from: number, to: number, via: "drag" | "menu") => void;
  onDuplicate: (uid: string) => void;
  onRemove: (uid: string) => void;
}

/** "Your README": the dnd-kit sortable list (pointer + KeyboardSensor), restyled on DS tokens. */
export default function SectionList({ sections, selectedUid, onSelect, onMove, onDuplicate, onRemove }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const names = useMemo(() => new Map(sections.map((s) => [s.uid, sectionName(s)])), [sections]);
  const pos = (id: UniqueIdentifier) => sections.findIndex((s) => s.uid === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `${names.get(String(active.id))}, grabbed. Position ${pos(active.id)} of ${sections.length}.`,
    onDragOver: ({ active, over }) =>
      over ? `${names.get(String(active.id))} is over position ${pos(over.id)} of ${sections.length}.` : `${names.get(String(active.id))} is no longer over the list.`,
    onDragEnd: ({ active, over }) =>
      over ? `${names.get(String(active.id))} dropped at position ${pos(over.id)} of ${sections.length}.` : `${names.get(String(active.id))} dropped.`,
    onDragCancel: ({ active }) => `Reordering cancelled. ${names.get(String(active.id))} is back at position ${pos(active.id)}.`,
  };

  // ── FLIP: a new or moved row glides from where it was (200ms). A drop is already in place, so
  // the change a drag causes is not animated again.
  const els = useRef(new Map<string, HTMLElement>());
  const tops = useRef<Map<string, number> | null>(null);
  const skipFlip = useRef(false);
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    els.current.forEach((el, uid) => next.set(uid, el.offsetTop));
    const prev = tops.current;
    tops.current = next;
    if (!prev || skipFlip.current || reducedMotion()) {
      skipFlip.current = false;
      return;
    }
    els.current.forEach((el, uid) => {
      const before = prev.get(uid);
      if (before === undefined) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-6px) scale(0.98)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: FLIP_MS, easing: EASE },
        );
        return;
      }
      const dy = before - (next.get(uid) ?? before);
      if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: FLIP_MS, easing: EASE });
    });
  }, [sections]);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = sections.findIndex((s) => s.uid === active.id);
    const to = sections.findIndex((s) => s.uid === over.id);
    if (from < 0 || to < 0) return;
    skipFlip.current = true;
    onMove(from, to, "drag");
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: INSTRUCTIONS }}
    >
      <SortableContext items={sections.map((s) => s.uid)} strategy={verticalListSortingStrategy}>
        <ul aria-label="Your README sections" className="relative flex min-w-0 flex-col gap-2">
          {sections.map((inst, i) => (
            <SectionRow
              key={inst.uid}
              inst={inst}
              index={i}
              count={sections.length}
              selected={inst.uid === selectedUid}
              register={(el) => {
                if (el) els.current.set(inst.uid, el);
                else els.current.delete(inst.uid);
              }}
              onSelect={() => onSelect(inst.uid)}
              onMove={(to) => onMove(i, to, "menu")}
              onDuplicate={() => onDuplicate(inst.uid)}
              onRemove={() => onRemove(inst.uid)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SectionRow({
  inst,
  index,
  count,
  selected,
  register,
  onSelect,
  onMove,
  onDuplicate,
  onRemove,
}: {
  inst: SectionInstance;
  index: number;
  count: number;
  selected: boolean;
  register: (el: HTMLElement | null) => void;
  onSelect: () => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: inst.uid });
  const name = sectionName(inst);
  const lift = isDragging && !reducedMotion() ? " scale(1.02)" : "";
  const style = {
    transform: (CSS.Translate.toString(transform) ?? "") + lift || undefined,
    transition,
  };

  const items: MenuItem[] = [
    { label: "Move up", icon: "chevronUp", disabled: index === 0, onClick: () => onMove(index - 1) },
    { label: "Move down", icon: "chevronDown", disabled: index === count - 1, onClick: () => onMove(index + 1) },
    { label: "Duplicate", icon: "copy", onClick: onDuplicate },
    { label: "Remove", icon: "trash", danger: true, separated: true, onClick: onRemove },
  ];

  return (
    <li
      ref={(el) => {
        setNodeRef(el);
        register(el);
      }}
      style={style}
      className={styles.row}
      data-selected={selected || undefined}
      data-dragging={isDragging || undefined}
    >
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        className={`md-iconbtn ${styles.grip} h-11 w-9 max-lg:w-11`}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${name}`}
        title="Drag to reorder"
      >
        <Icon name="grip" />
      </Button>
      <button type="button" className={`${styles.select} md-focus`} onClick={onSelect} aria-current={selected ? "true" : undefined} data-select-uid={inst.uid}>
        <span className={styles.tile} aria-hidden="true">
          <SectionIcon id={inst.templateId} size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate text-body-strong">{name}</span>
      </button>
      <Dropdown
        portal
        align="right"
        trigger={<IconButton icon="more" label={`More actions for ${name}`} className="max-lg:h-11 max-lg:w-11" />}
        items={items}
      />
    </li>
  );
}
