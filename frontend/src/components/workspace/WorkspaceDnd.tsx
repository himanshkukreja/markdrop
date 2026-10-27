"use client";

/**
 * Drag and drop for workspace folders (P2): items onto a folder (in the list or the rail), and
 * folders onto a folder (admins). One DndContext wraps the rail and the page (AppShell), so a row
 * in the folder view can land on a folder in the rail.
 *
 * Pointer only. The keyboard and phone way to do the same thing is "Move to…" (a tree picker), so
 * there is no keyboard sensor here: a keyboard drag across a tree of links is harder to use than a
 * dialog that lists the folders. Activation needs a 6px move (a click on a row's link still opens
 * it) or, on touch, a 300ms press (a swipe still scrolls).
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable,
  useSensor, useSensors, type Announcements, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { Icon, useToast } from "@/components/ui";
import { errorStatus, moveItems, updateFolder } from "@/lib/workspaces";
import { workspaceChanged } from "@/lib/workspaceStore";

export type DragData =
  /** `fromFolderId` undefined: the items come from more than one folder (search results). */
  | { type: "items"; workspaceId: string; slugs: string[]; label: string; fromFolderId: string | null | undefined }
  | { type: "folder"; workspaceId: string; folderId: string; label: string; parentId: string | null; blocked: string[] };

export interface DropData {
  workspaceId: string;
  /** null = the workspace's top level. */
  folderId: string | null;
  label: string;
  /** Folders may only be dropped by admins. */
  acceptsFolders: boolean;
}

/** Whether `drag` may land on `drop` (same workspace, not where it already is, not into itself). */
export function canDrop(drag: DragData | null, drop: DropData | null): boolean {
  if (!drag || !drop || drag.workspaceId !== drop.workspaceId) return false;
  if (drag.type === "items") return drag.fromFolderId === undefined || drag.fromFolderId !== drop.folderId;
  if (!drop.acceptsFolders) return false;
  if (drop.folderId === drag.folderId || drop.folderId === drag.parentId) return false;
  return !drop.folderId || !drag.blocked.includes(drop.folderId);
}

const Ctx = createContext<{ active: DragData | null }>({ active: null });
export const useWorkspaceDrag = () => useContext(Ctx);

/** Pointer inside a target wins; otherwise the largest overlap (for a fast drop on a card edge). */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length ? within : rectIntersection(args);
};

export function WorkspaceDndProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const [active, setActive] = useState<DragData | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
  );

  const onStart = useCallback((e: DragStartEvent) => {
    setActive((e.active.data.current as DragData | undefined) ?? null);
  }, []);

  const onEnd = useCallback(async (e: DragEndEvent) => {
    const drag = (e.active.data.current as DragData | undefined) ?? null;
    const drop = (e.over?.data.current as DropData | undefined) ?? null;
    setActive(null);
    if (!drag || !drop || !canDrop(drag, drop)) return;
    const ws = drag.workspaceId;
    try {
      if (drag.type === "items") {
        await moveItems(ws, drag.slugs, drop.folderId);
        workspaceChanged(ws);
        const from = drag.fromFolderId;
        toast.toast({
          message: `Moved ${drag.slugs.length === 1 ? `“${drag.label}”` : drag.label} to ${drop.label}`,
          kind: "success",
          // Undo needs one place to go back to; search results can come from several.
          action: from === undefined ? undefined : {
            label: "Undo",
            onClick: () => {
              void moveItems(ws, drag.slugs, from)
                .then(() => { workspaceChanged(ws); toast.success("Moved back"); })
                .catch((err) => toast.error(err instanceof Error ? err.message : "Couldn't move it back"));
            },
          },
        });
      } else {
        await updateFolder(ws, drag.folderId, { parent_id: drop.folderId });
        workspaceChanged(ws);
        const from = drag.parentId;
        toast.toast({
          message: `Moved “${drag.label}” into ${drop.label}`,
          kind: "success",
          action: {
            label: "Undo",
            onClick: () => {
              void updateFolder(ws, drag.folderId, { parent_id: from })
                .then(() => { workspaceChanged(ws); toast.success("Moved back"); })
                .catch((err) => toast.error(err instanceof Error ? err.message : "Couldn't move it back"));
            },
          },
        });
      }
    } catch (err) {
      const s = errorStatus(err);
      toast.error(
        s === 403 ? "You don't have permission to move that here."
          : err instanceof Error && err.message ? err.message : "Couldn't move it. Try again.",
      );
    }
  }, [toast]);

  const announcements: Announcements = useMemo(() => ({
    onDragStart: ({ active: a }) => `Picked up ${(a.data.current as DragData | undefined)?.label ?? "item"}.`,
    onDragOver: ({ active: a, over }) => {
      const drop = over?.data.current as DropData | undefined;
      if (!drop) return "Not over a folder.";
      return canDrop(a.data.current as DragData, drop) ? `Over ${drop.label}. Release to move here.` : `Can't move here: ${drop.label}.`;
    },
    onDragEnd: ({ over }) => {
      const drop = over?.data.current as DropData | undefined;
      return drop ? `Dropped on ${drop.label}.` : "Dropped. Nothing moved.";
    },
    onDragCancel: () => "Move cancelled.",
  }), []);

  return (
    <Ctx.Provider value={{ active }}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onStart}
        onDragEnd={(e) => void onEnd(e)}
        onDragCancel={() => setActive(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: "To move this without dragging, open its menu and choose Move to." },
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active ? (
            <div className="pointer-events-none inline-flex max-w-72 items-center gap-2 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-body-strong text-text shadow-lg">
              <Icon name={active.type === "folder" ? "folder" : active.type === "items" && active.slugs.length > 1 ? "layers" : "doc"} size={16} className="shrink-0 text-accent-text" />
              <span className="truncate" dir="auto">{active.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </Ctx.Provider>
  );
}

/** Make an element a drop target for `data` (disabled when `data` is null). */
export function useFolderDrop(id: string, data: DropData | null) {
  const { active } = useWorkspaceDrag();
  const { setNodeRef, isOver } = useDroppable({ id: `drop:${id}`, data: data ?? undefined, disabled: !data });
  const allowed = !!data && canDrop(active, data);
  return {
    setNodeRef,
    /** A drag is in progress and could land here. */
    candidate: allowed,
    /** The pointer is over this target and the drop would be accepted. */
    over: isOver && allowed,
  };
}

/** Make an element draggable (nothing happens when `data` is null). Spread `listeners` on it. */
export function useWorkspaceDraggable(id: string, data: DragData | null) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `drag:${id}`, data: data ?? undefined, disabled: !data });
  return { setNodeRef, listeners: data ? listeners : undefined, isDragging };
}
