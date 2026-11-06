/**
 * Where /meetings/start sends someone: the landing's "Start with your team" (the "Your workspace
 * remembers" section). Signed out, the page sends them to /login?next=/meetings/start first.
 *
 * - The first workspace (the server lists them oldest first) where they can bring meetings in
 *   (Member or above): its Meetings, with the Connect Google Meet steps open (?connect=1).
 * - Only Viewer somewhere: that workspace's Meetings, to read (a viewer can't connect).
 * - No workspace: the New workspace dialog, which then goes to the new one's Meetings and Connect.
 *
 * Pure (no imports), so node --test runs it: src/lib/meetingsStart.test.mjs.
 */

export const MEETINGS_START_PATH = "/meetings/start";

type Ws = { id: string; role?: string };

const CAN_IMPORT = new Set(["member", "admin", "owner"]);

/** The workspace's Meetings with the Connect Google Meet steps open. */
export const meetingsStartHref = (workspaceId: string) => `/meetings/${encodeURIComponent(workspaceId)}?connect=1`;

export function meetingsStartTarget(workspaces: readonly Ws[] | null | undefined): string {
  const list = (workspaces ?? []).filter((w) => w && typeof w.id === "string" && w.id);
  const importable = list.find((w) => CAN_IMPORT.has(w.role ?? ""));
  if (importable) return meetingsStartHref(importable.id);
  if (list[0]) return `/meetings/${encodeURIComponent(list[0].id)}`;
  return "/settings/workspaces?new=1&then=meetings";
}

/** The sign-in URL that comes back here once signed in (Google or an email code). */
export const meetingsStartLogin = () => `/login?next=${encodeURIComponent(MEETINGS_START_PATH)}`;
