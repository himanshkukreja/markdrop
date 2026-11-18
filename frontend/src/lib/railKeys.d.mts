import type { TeamCard, TeamsSidebar } from "./teams";

export type TeamSection = "overview" | "meetings" | "deals" | "files" | "memory";
export const TEAM_SECTIONS: readonly TeamSection[];
export function wsRootKey(id: string): string;
export function wsFolderKey(id: string, folderId: string): string;
export function wsSettingsKey(id: string): string;
export function wsMeetingsKey(id: string): string;
export function wsCompanyMeetingsKey(id: string): string;
export function wsTeamKey(id: string): string;
export function wsBrowseKey(id: string): string;
export function wsReviewKey(id: string): string;
export const ALL_DEALS_KEY: "deals";
export function wsDealsKey(id: string): string;
export function wsTeamRowKey(id: string, teamId: string, sub?: string): string;
export function railKeyFor(pathname: string, search: string): string | null;
export function workspaceOfKey(key: string | null | undefined): string | null;
export function askLinkFor(active: string | null, wsFallback?: string | null): string;
export function generalOf(teams: TeamsSidebar | null | false | undefined): TeamCard | undefined;
export function resolveRailKey(
  active: string | null,
  teams: Pick<TeamsSidebar, "teams" | "projects"> | null | false | undefined,
  folders?: ReadonlyArray<{ id: string; parent_id: string | null; team_ids?: string[] }> | null,
): { key: string | null; open: string[] };
