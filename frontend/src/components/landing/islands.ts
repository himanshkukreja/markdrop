import type { ComponentType } from "react";

/**
 * Interactive halves of the landing page, loaded on demand by <LazyIsland>. Each entry is its own
 * chunk, so `/` ships none of this JavaScript until a section nears the viewport (or, for the hero,
 * until the browser is idle after first paint). The static first frame of every section is
 * server-rendered HTML, identical to the game's first render, so the swap causes no layout shift.
 */
export const ISLANDS = {
  hero: () => import("./orbit/Game"),
  "render-bench": () => import("./toys/RenderBench/Game"),
  "link-forge": () => import("./toys/LinkForge/Game"),
  "key-lab": () => import("./toys/KeyLab/Game"),
  "sync-desk": () => import("./toys/SyncDesk/Game"),
  "send-sim": () => import("./toys/SendSim/Game"),
  "domain-studio": () => import("./toys/DomainStudio/Game"),
  "builder-blocks": () => import("./toys/BuilderBlocks/Game"),
  "can-they-open": () => import("./toys/CanTheyOpen/Game"),
} satisfies Record<string, () => Promise<{ default: ComponentType }>>;

export type IslandName = keyof typeof ISLANDS;
