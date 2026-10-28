/**
 * When a workspace still shows "Get set up" (NewWorkspace board). Only genuinely new workspaces:
 * made in the last 14 days and still holding fewer than 3 items, and only until the three core
 * steps (name, invite your team, add your first file) are done. Never on an established
 * workspace, however its counts look. No imports, so `node --test` can load it as is.
 */
export const SETUP_WINDOW_DAYS = 14;
export const SETUP_MAX_ITEMS = 3;

export interface SetupFacts {
  /** The workspace's `created_at` (ISO). Unknown ⇒ treated as established. */
  createdAt: string | null | undefined;
  /** Items in the whole workspace the caller can see. */
  itemCount: number;
  invited: boolean;
  hasFile: boolean;
  /** Always true today (a workspace can't exist without a name); kept so the rule says so. */
  named?: boolean;
  /** Milliseconds since the epoch; defaults to now. */
  now?: number;
}

export function isNewWorkspace(createdAt: string | null | undefined, itemCount: number, now = Date.now()): boolean {
  if (!createdAt) return false;
  const born = Date.parse(createdAt);
  if (Number.isNaN(born)) return false;
  const age = now - born;
  return age >= -60_000 && age <= SETUP_WINDOW_DAYS * 86_400_000 && itemCount < SETUP_MAX_ITEMS;
}

export function shouldShowSetup(f: SetupFacts): boolean {
  const coreDone = (f.named ?? true) && f.invited && f.hasFile;
  return !coreDone && isNewWorkspace(f.createdAt, f.itemCount, f.now ?? Date.now());
}
