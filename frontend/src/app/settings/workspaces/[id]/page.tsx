"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import MarkdropLoader from "@/components/MarkdropLoader";
import CopyButton from "@/components/CopyButton";
import DnsHandoff from "@/components/workspace/DnsHandoff";
import { downloadDnsCsv } from "@/lib/dnsCsv";
import AssetUpload from "@/components/workspace/AssetUpload";
import ColorPicker from "@/components/workspace/ColorPicker";
import LibraryPanel from "@/components/workspace/LibraryPanel";
import {
  can, deleteWorkspace, getWorkspace, updateWorkspace, uploadBrandingAsset,
  listDomains, addDomain, verifyDomain, attachDomain, removeDomain,
  listMembers, setMemberRole, removeMember,
  listInvitations, inviteMember, revokeInvitation,
  listFolders, createFolder, deleteFolder,
  type Branding, type Domain, type DomainKind, type Folder, type Invitation,
  type Member, type Role, type ViewerChrome, type Workspace, type WorkspaceSettings,
} from "@/lib/workspaces";

const input =
  "bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors";
const primary =
  "px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors";
const ghost =
  "px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors";

type TabId = "library" | "brand" | "domains" | "people" | "folders";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  {
    id: "library", label: "Library",
    icon: <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />,
  },
  {
    id: "brand", label: "Brand & viewer",
    icon: <path d="M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5" />,
  },
  {
    id: "domains", label: "Domains",
    icon: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" /></>,
  },
  {
    id: "people", label: "People",
    icon: <><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>,
  },
  {
    id: "folders", label: "Folders",
    icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  },
];

function Icon({ children, className = "w-4 h-4" }: { children: React.ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

/** A titled panel. Everything on this page lives in one of these. */
function Card({
  title, hint, aside, children, className = "",
}: {
  title?: string; hint?: string; aside?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-gray-200/80 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white/70 dark:bg-gray-900/40 backdrop-blur-sm ${className}`}
    >
      {title && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {hint && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed max-w-2xl">{hint}</p>
            )}
          </div>
          {aside}
        </header>
      )}
      <div className={title ? "px-5 pb-5" : "p-5"}>{children}</div>
    </section>
  );
}

function StatusPill({ tone, children }: { tone: "ok" | "wait" | "bad" | "mute"; children: React.ReactNode }) {
  const tones = {
    ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    wait: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bad: "bg-red-500/10 text-red-600 dark:text-red-400",
    mute: "bg-gray-500/10 text-gray-500 dark:text-gray-400",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * What branding actually changes, shown as the two artefacts people judge a link
 * by: the browser tab, and the card that unfurls in Slack or LinkedIn. Both
 * update as you type, because "site name" and "hide Markdrop branding" are
 * otherwise abstract until a link is already out in the world.
 */
function BrandPreview({ branding, host }: { branding: Branding; host: string | null }) {
  const name = branding.site_name?.trim() || "Markdrop";
  const accent = branding.accent_color || "#3b82f6";
  const domain = host || "markdrop.in";

  return (
    <div className="space-y-4">
      {/* Browser tab */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Browser tab</p>
        <div className="rounded-t-lg bg-gray-200/70 dark:bg-gray-800 px-2 pt-2">
          <div className="flex items-center gap-1.5 rounded-t-md bg-white dark:bg-gray-900 px-2.5 py-1.5 max-w-[85%]">
            {branding.favicon_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.favicon_url} alt="" className="w-3.5 h-3.5 rounded-[3px] shrink-0 object-contain"
                   onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }} />
            ) : (
              <span className="w-3.5 h-3.5 rounded-[3px] shrink-0 grid place-items-center text-[8px] font-bold text-white"
                    style={{ background: accent }}>{name[0]?.toUpperCase()}</span>
            )}
            <span className="text-[11px] truncate text-gray-700 dark:text-gray-300">Quarterly plan — {name}</span>
            <span className="ml-auto text-gray-400 text-[11px] leading-none">×</span>
          </div>
        </div>
        <div className="rounded-b-lg bg-white dark:bg-gray-900 border-x border-b border-gray-200 dark:border-gray-800 px-2.5 py-2">
          <div className="rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-[10px] font-mono text-gray-500 truncate">
            {domain}/quarterly-plan
          </div>
        </div>
      </div>

      {/* Link unfurl */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Shared link</p>
        <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <div className="h-20 relative" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}55)` }}>
            {branding.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logo_url} alt=""
                   className="absolute inset-0 m-auto max-h-10 max-w-[55%] object-contain drop-shadow"
                   onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-white/90 text-sm font-bold tracking-tight">
                {name}
              </span>
            )}
          </div>
          <div className="px-3 py-2.5">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide">{domain}</p>
            <p className="text-[13px] font-semibold truncate mt-0.5">Quarterly plan</p>
            <p className="text-[11px] text-gray-500 truncate">
              Revenue, headcount and roadmap for the next quarter.
            </p>
            {!branding.hide_markdrop_branding && (
              <p className="text-[10px] text-gray-400 mt-1.5">Published with Markdrop</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One DNS row, formatted to be pasted into a registrar without editing. */
function DnsRow({ label, type, name, value }: { label: string; type: string; name: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-[11px] py-1.5">
      <span className="w-16 shrink-0 text-gray-400 pt-0.5">{label}</span>
      <span className="w-12 shrink-0 font-mono text-gray-500">{type}</span>
      <code className="flex-1 min-w-0 font-mono break-all text-gray-700 dark:text-gray-300">{name}</code>
      <code className="flex-1 min-w-0 font-mono break-all text-gray-700 dark:text-gray-300">{value}</code>
      <CopyButton text={value} label="Copy" />
    </div>
  );
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "W";
}

function relativeDays(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return "tomorrow";
  if (days === 0) return "today";
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
}

export default function WorkspaceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [ws, setWs] = useState<Workspace | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [tab, setTab] = useState<TabId>("library");

  const [branding, setBranding] = useState<Branding | null>(null);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [newHost, setNewHost] = useState("");
  const [newKind, setNewKind] = useState<DomainKind>("app");
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Exclude<Role, "owner">>("member");
  const [newFolder, setNewFolder] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteName, setDeleteName] = useState("");

  const load = useCallback(async () => {
    try {
      const w = await getWorkspace(id);
      setWs(w);
      setBranding(w.branding);
      setSettings(w.settings);
      // Each of these needs a different minimum role, so a non-admin simply gets
      // an empty list rather than an error that blanks the whole page.
      const [d, m, i, f] = await Promise.all([
        listDomains(id).catch(() => []),
        listMembers(id).catch(() => []),
        listInvitations(id).catch(() => []),
        listFolders(id).catch(() => []),
      ]);
      setDomains(d); setMembers(m); setInvites(i); setFolders(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this workspace");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace(`/login?next=/settings/workspaces/${id}`); return; }
    load();
  }, [authLoading, user, router, id, load]);

  async function run(key: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(key); setError(""); setSaved("");
    try { await fn(); after?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(""); }
  }

  const pending = useMemo(() => invites.filter((i) => i.status === "pending"), [invites]);
  const resolved = useMemo(() => invites.filter((i) => i.status !== "pending"), [invites]);

  if (authLoading || loading) {
    return (
      <div className="flex-1 min-h-[60vh] flex items-center justify-center">
        <MarkdropLoader label="Loading workspace…" />
      </div>
    );
  }
  if (!ws || !branding || !settings) {
    return (
      <div className="flex-1 max-w-2xl mx-auto w-full py-12 text-center">
        <p className="text-sm text-gray-500">{error || "Workspace not found."}</p>
        <a href="/settings/workspaces" className="text-sm text-blue-500 hover:underline mt-3 inline-block">← All workspaces</a>
      </div>
    );
  }

  const verifiedHost = domains.find((d) => d.status === "verified" && d.kind === "app")?.host ?? null;
  const isAdmin = can(ws.role, "admin");
  const isMember = can(ws.role, "member");
  const accent = branding.accent_color || "#3b82f6";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto w-full">
      {/* ── Hero ──────────────────────────────────────────────────────────
          Tinted with the workspace's own accent, so the setting is visible on
          the page that sets it rather than only out on a published link. */}
      <div className="relative overflow-hidden border-b border-gray-200 dark:border-gray-800">
        <div
          className="absolute inset-0 opacity-[0.10] pointer-events-none"
          style={{ background: `radial-gradient(900px 200px at 12% -40%, ${accent}, transparent 70%)` }}
          aria-hidden
        />
        <div className="relative max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 py-6">
          <a href="/settings/workspaces"
             className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1">
            <Icon className="w-3 h-3"><path d="m15 18-6-6 6-6" /></Icon> All workspaces
          </a>

          <div className="mt-3 flex items-start gap-4 flex-wrap">
            <div className="w-12 h-12 rounded-xl grid place-items-center overflow-hidden shrink-0 shadow-sm"
                 style={{ background: branding.logo_url ? "transparent" : accent }}>
              {branding.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={branding.logo_url} alt="" className="w-full h-full object-contain"
                     onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              ) : (
                <span className="text-white font-bold text-sm">{initials(ws.name)}</span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold truncate leading-tight">{ws.name}</h1>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px]">
                <StatusPill tone="mute"><span className="capitalize">{ws.role}</span></StatusPill>
                {verifiedHost && (
                  <StatusPill tone="ok">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span className="font-mono">{verifiedHost}</span>
                  </StatusPill>
                )}
                <span className="text-gray-400">
                  {members.length} member{members.length === 1 ? "" : "s"}
                  {pending.length > 0 && ` · ${pending.length} invited`}
                  {` · ${domains.length} domain${domains.length === 1 ? "" : "s"}`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 py-6 pb-24">
        <div className="grid lg:grid-cols-[190px_minmax(0,1fr)] gap-6 lg:gap-8 items-start">
          {/* Tabs, not anchors: each pane gets the whole width instead of
              competing with four others in one long scroll. */}
          <nav className="lg:sticky lg:top-4 flex lg:flex-col gap-1 overflow-x-auto pb-1 -mx-1 px-1"
               role="tablist" aria-label="Workspace settings">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.id)}
                  className={`shrink-0 flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                    active
                      ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-medium"
                      : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
                  }`}
                >
                  <Icon>{t.icon}</Icon>
                  {t.label}
                  {t.id === "people" && pending.length > 0 && (
                    <span className={`ml-auto text-[10px] px-1.5 rounded-full ${
                      active ? "bg-white/20 dark:bg-black/10" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}>
                      {pending.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 space-y-5">
            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
            {saved && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
                {saved}
              </div>
            )}
            {!isAdmin && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-2.5 text-xs text-gray-500">
                You can view this workspace. Changing branding, domains or people needs the admin role.
              </div>
            )}

            {/* ── Shared library ─────────────────────────────────────────── */}
            {tab === "library" && (
              <Card
                title="Shared library"
                hint="Documents and artifacts people have chosen to share with this workspace. Private documents never appear here — they stay private until their owner shares them."
              >
                <LibraryPanel
                  workspaceId={id}
                  role={ws.role}
                  folders={folders}
                  accent={accent}
                  onError={setError}
                />
              </Card>
            )}

            {/* ── Brand & viewer ─────────────────────────────────────────── */}
            {tab === "brand" && (
              <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] gap-5 items-start">
                <div className="space-y-5">
                  <Card
                    title="Brand"
                    hint="Applied to page titles, the favicon and link preview cards on your own verified domains. Anything left blank falls back to Markdrop's."
                  >
                    <div className="space-y-4">
                      <div>
                        <label className="text-[13px] font-medium text-gray-700 dark:text-gray-300 block mb-1.5">
                          Site name
                        </label>
                        <input className={`${input} w-full`} placeholder="Acme Docs" maxLength={60}
                          value={branding.site_name ?? ""} disabled={!isAdmin}
                          onChange={(e) => setBranding({ ...branding, site_name: e.target.value || null })} />
                        <p className="text-[11px] text-gray-400 mt-1">Replaces “Markdrop” in titles and cards.</p>
                      </div>

                      <div className="grid sm:grid-cols-2 gap-4">
                        <AssetUpload
                          label="Favicon"
                          hint="PNG, JPEG, WebP or GIF. Re-encoded and resized to 128px."
                          value={branding.favicon_url}
                          disabled={!isAdmin}
                          onUpload={async (file) => {
                            const url = await uploadBrandingAsset(id, "favicon", file);
                            setBranding((b) => (b ? { ...b, favicon_url: url } : b));
                          }}
                          onClear={() => setBranding({ ...branding, favicon_url: null })}
                        />
                        <AssetUpload
                          label="Logo"
                          hint="PNG, JPEG, WebP or GIF. Shown on link preview cards."
                          shape="wide"
                          value={branding.logo_url}
                          disabled={!isAdmin}
                          onUpload={async (file) => {
                            const url = await uploadBrandingAsset(id, "logo", file);
                            setBranding((b) => (b ? { ...b, logo_url: url } : b));
                          }}
                          onClear={() => setBranding({ ...branding, logo_url: null })}
                        />
                      </div>

                      <ColorPicker
                        value={branding.accent_color}
                        disabled={!isAdmin}
                        onChange={(hex) => setBranding({ ...branding, accent_color: hex })}
                      />

                      <label className="flex items-start gap-2.5 text-xs text-gray-600 dark:text-gray-400 pt-1 cursor-pointer">
                        <input type="checkbox" checked={branding.hide_markdrop_branding} disabled={!isAdmin}
                          onChange={(e) => setBranding({ ...branding, hide_markdrop_branding: e.target.checked })}
                          className="accent-blue-600 mt-0.5" />
                        <span>
                          White-label preview cards
                          <span className="block text-gray-400">Removes “Published with Markdrop” from cards and titles.</span>
                        </span>
                      </label>
                    </div>
                  </Card>

                  <Card
                    title="Viewer behaviour"
                    hint="Only ever applies on your own verified domains — never on markdrop.in, where we stay accountable for what's served."
                  >
                    <div className="space-y-3">
                      <select className={`${input} w-full cursor-pointer`} value={settings.viewer_chrome} disabled={!isAdmin}
                        onChange={(e) => setSettings({ ...settings, viewer_chrome: e.target.value as ViewerChrome })}>
                        <option value="full">Full — visitors can leave full screen and see document details</option>
                        <option value="minimal">Minimal</option>
                        <option value="none">View only — no controls for signed-out visitors (CDN mode)</option>
                      </select>
                      <label className="flex items-start gap-2.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                        <input type="checkbox" checked={settings.require_auth_to_view} disabled={!isAdmin}
                          onChange={(e) => setSettings({ ...settings, require_auth_to_view: e.target.checked })}
                          className="accent-blue-600 mt-0.5" />
                        <span>
                          Require sign-in to read this workspace&apos;s documents
                          <span className="block text-gray-400">Enforced everywhere, including markdrop.in links.</span>
                        </span>
                      </label>
                    </div>
                  </Card>

                  {isAdmin && (
                    <div className="flex items-center gap-3">
                      <button className={primary} disabled={busy === "save"}
                        onClick={() => run("save",
                          () => updateWorkspace(id, { branding, settings }),
                          () => { setSaved("Saved."); load(); })}>
                        {busy === "save" ? "Saving…" : "Save changes"}
                      </button>
                      <span className="text-[11px] text-gray-400">
                        Uploads are stored immediately; everything else applies on save.
                      </span>
                    </div>
                  )}

                  {/* Owner only. An admin runs a workspace; only the owner ends it. */}
                  {ws.role === "owner" && (
                    <Card className="!border-red-500/25">
                      <h2 className="text-sm font-semibold text-red-600 dark:text-red-400">
                        Delete this workspace
                      </h2>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed max-w-2xl">
                        Removes the workspace, its members, folders and domains. Shared documents
                        are <strong>not</strong> deleted — they go back to the people who own them,
                        with the same links and analytics.
                      </p>

                      {!confirmDelete ? (
                        <button
                          onClick={() => { setConfirmDelete(true); setDeleteName(""); }}
                          className="mt-3 px-4 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-sm font-medium transition-colors"
                        >
                          Delete workspace
                        </button>
                      ) : (
                        <div className="mt-3 space-y-2.5">
                          <p className="text-xs text-gray-600 dark:text-gray-400">
                            Type <strong className="font-mono">{ws.name}</strong> to confirm.
                          </p>
                          <input
                            autoFocus
                            value={deleteName}
                            onChange={(e) => setDeleteName(e.target.value)}
                            placeholder={ws.name}
                            className={`${input} w-full max-w-sm`}
                          />
                          <div className="flex gap-2">
                            <button
                              disabled={busy === "delete" || deleteName.trim() !== ws.name.trim()}
                              onClick={() => run("delete",
                                () => deleteWorkspace(id, deleteName.trim()),
                                () => router.push("/settings/workspaces"))}
                              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                            >
                              {busy === "delete" ? "Deleting…" : "Delete permanently"}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(false)}
                              disabled={busy === "delete"}
                              className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </Card>
                  )}
                </div>

                <div className="xl:sticky xl:top-4">
                  <Card title="Live preview" hint="How this workspace's links look to everyone else.">
                    <BrandPreview branding={branding} host={verifiedHost} />
                  </Card>
                </div>
              </div>
            )}

            {/* ── Domains ────────────────────────────────────────────────── */}
            {tab === "domains" && (
              <Card
                title="Domains"
                hint="Any hostname you control. “Documents” serves pages and sign-in; “Files only” serves uploaded artifacts and never runs the app — one host can't do both."
                aside={domains.length > 0 ? (
                  <button
                    onClick={() => downloadDnsCsv(domains)}
                    className={`${ghost} shrink-0 inline-flex items-center gap-1.5`}
                    title="Download every DNS record for this workspace as CSV"
                  >
                    <Icon className="w-3.5 h-3.5"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Icon>
                    Download all as CSV
                  </button>
                ) : undefined}
              >
                {isAdmin && (
                  <div className="flex gap-2 mb-4 flex-wrap">
                    <input className={`${input} flex-1 min-w-[220px]`} placeholder="docs.yourcompany.com"
                      value={newHost} onChange={(e) => setNewHost(e.target.value)} />
                    <select className={`${input} cursor-pointer`} value={newKind}
                      onChange={(e) => setNewKind(e.target.value as DomainKind)}>
                      <option value="app">Documents</option>
                      <option value="cdn">Files only</option>
                    </select>
                    <button className={primary} disabled={busy === "domain" || !newHost.trim()}
                      onClick={() => run("domain",
                        () => addDomain(id, newHost.trim(), newKind),
                        () => { setNewHost(""); load(); })}>
                      {busy === "domain" ? "Adding…" : "Add domain"}
                    </button>
                  </div>
                )}

                {domains.length === 0 ? (
                  <p className="text-xs text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl px-3 py-10 text-center">
                    No domains yet. Add one to serve documents from your own hostname.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {domains.map((d) => (
                      <div key={d.id} className="border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-xl p-3.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-sm font-mono">{d.host}</code>
                          <StatusPill tone="mute">{d.kind === "app" ? "Documents" : "Files only"}</StatusPill>
                          <StatusPill tone={d.status === "verified" ? "ok" : d.status === "failed" ? "bad" : "wait"}>
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              d.status === "verified" ? "bg-emerald-500"
                                : d.status === "failed" ? "bg-red-500" : "bg-amber-500 animate-pulse"}`} />
                            {d.status === "verified" ? "Live" : d.status === "failed" ? "Failed" : "Awaiting DNS"}
                          </StatusPill>
                          {d.attached && <span className="text-[10px] text-gray-400">· attached</span>}
                          {isAdmin && (
                            <div className="ml-auto flex gap-1.5">
                              <button className={ghost} disabled={busy === `v${d.id}`}
                                onClick={() => run(`v${d.id}`, () => verifyDomain(id, d.id), load)}>
                                {busy === `v${d.id}` ? "Checking…" : "Check DNS"}
                              </button>
                              {d.status === "verified" && !d.attached && (
                                <button className={ghost} disabled={busy === `a${d.id}`}
                                  onClick={() => run(`a${d.id}`, () => attachDomain(id, d.id), load)}>
                                  {busy === `a${d.id}` ? "Attaching…" : "Attach"}
                                </button>
                              )}
                              <button className={`${ghost} text-red-500 border-red-300 dark:border-red-900`}
                                onClick={() => run(`d${d.id}`, () => removeDomain(id, d.id), load)}>
                                Remove
                              </button>
                            </div>
                          )}
                        </div>

                        {d.status !== "verified" && (
                          <div className="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-gray-800">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <p className="text-[11px] text-gray-500">Add both records at your DNS provider, then Check DNS.</p>
                              <span className="shrink-0 flex items-center gap-3">
                                <DnsHandoff
                                  domains={[d]}
                                  siteName={branding.site_name || undefined}
                                  className="text-[11px] text-gray-500 hover:text-blue-500 transition-colors"
                                />
                                <button
                                  onClick={() => downloadDnsCsv([d])}
                                  className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-blue-500 transition-colors"
                                  title={`Download the DNS records for ${d.host} as CSV`}
                                >
                                  <Icon className="w-3 h-3"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Icon>
                                  CSV
                                </button>
                              </span>
                            </div>
                            <DnsRow label="Ownership" type={d.dns_record_type} name={d.dns_record_name} value={d.dns_record_value} />
                            <DnsRow label="Routing" type={d.dns_target_type} name={d.dns_target_name} value={d.dns_target_value} />
                          </div>
                        )}
                        {d.last_error && <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-2">{d.last_error}</p>}
                        {d.warning && <p className="text-[11px] text-gray-500 mt-2">{d.warning}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* ── People ─────────────────────────────────────────────────── */}
            {tab === "people" && (
              <div className="space-y-5">
                {isAdmin && (
                  <Card
                    title="Invite someone"
                    hint="They get an email with a link. Nothing changes until they accept it — nobody is added to a workspace without agreeing to join."
                  >
                    <div className="flex gap-2 flex-wrap">
                      <input className={`${input} flex-1 min-w-[220px]`} placeholder="person@company.com" type="email"
                        value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                      <select className={`${input} cursor-pointer`} value={newRole}
                        onChange={(e) => setNewRole(e.target.value as Exclude<Role, "owner">)}>
                        <option value="viewer">Viewer — read only</option>
                        <option value="member">Member — publish documents</option>
                        <option value="admin">Admin — manage everything</option>
                      </select>
                      <button className={primary} disabled={busy === "invite" || !newEmail.trim()}
                        onClick={() => run("invite",
                          () => inviteMember(id, newEmail.trim(), newRole),
                          () => { setNewEmail(""); setSaved("Invitation sent."); load(); })}>
                        {busy === "invite" ? "Sending…" : "Send invitation"}
                      </button>
                    </div>
                  </Card>
                )}

                {pending.length > 0 && (
                  <Card title="Waiting to be accepted" hint="Invitations expire after 7 days. Sending again to the same address issues a fresh link.">
                    <div className="rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
                      {pending.map((i) => (
                        <div key={i.id} className="flex items-center gap-3 px-3.5 py-2.5 flex-wrap">
                          <span className="w-8 h-8 rounded-full bg-amber-500/10 grid place-items-center shrink-0">
                            <Icon className="w-3.5 h-3.5 text-amber-500">
                              <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>
                            </Icon>
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm truncate">{i.email}</p>
                            <p className="text-[11px] text-gray-400">
                              Invited as {i.role} · expires {relativeDays(i.expires_at)}
                            </p>
                          </div>
                          {isAdmin && (
                            <div className="flex gap-1.5">
                              <button className={ghost} disabled={busy === `ri${i.id}`}
                                onClick={() => run(`ri${i.id}`,
                                  () => inviteMember(id, i.email, i.role as Exclude<Role, "owner">),
                                  () => { setSaved("Invitation resent."); load(); })}>
                                {busy === `ri${i.id}` ? "Sending…" : "Resend"}
                              </button>
                              <button className={`${ghost} text-red-500 border-red-300 dark:border-red-900`}
                                disabled={busy === `xi${i.id}`}
                                onClick={() => run(`xi${i.id}`, () => revokeInvitation(id, i.id), load)}>
                                Revoke
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                <Card title="Members" hint="Everyone who accepted. Roles take effect immediately.">
                  <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] divide-y divide-gray-100 dark:divide-gray-800">
                    {members.map((m) => (
                      <div key={m.user_id} className="flex items-center gap-3 px-3.5 py-2.5">
                        <span className="w-8 h-8 rounded-full grid place-items-center shrink-0 text-[11px] font-semibold text-white"
                              style={{ background: accent }}>
                          {initials(m.name || m.email || "?")}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate">
                            {m.name || m.email}
                            {m.user_id === user?.id && <span className="text-gray-400 font-normal"> · you</span>}
                          </p>
                          {m.name && <p className="text-[11px] text-gray-400 truncate">{m.email}</p>}
                        </div>
                        {m.user_id === ws.owner_id ? (
                          <StatusPill tone="mute">Owner</StatusPill>
                        ) : isAdmin ? (
                          <>
                            <select className="text-xs bg-transparent border border-gray-200 dark:border-gray-700 rounded px-1.5 py-1 cursor-pointer"
                              value={m.role}
                              onChange={(e) => run(`r${m.user_id}`,
                                () => setMemberRole(id, m.user_id, e.target.value as Exclude<Role, "owner">), load)}>
                              <option value="viewer">Viewer</option>
                              <option value="member">Member</option>
                              <option value="admin">Admin</option>
                            </select>
                            <button className="text-xs text-red-500 hover:text-red-600 px-1.5"
                              onClick={() => run(`m${m.user_id}`, () => removeMember(id, m.user_id), load)}>
                              Remove
                            </button>
                          </>
                        ) : (
                          <StatusPill tone="mute"><span className="capitalize">{m.role}</span></StatusPill>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>

                {resolved.length > 0 && (
                  <Card title="Invitation history">
                    <div className="space-y-1">
                      {resolved.map((i) => (
                        <div key={i.id} className="flex items-center gap-3 text-xs py-1.5">
                          <span className="text-gray-600 dark:text-gray-400 truncate flex-1">{i.email}</span>
                          <StatusPill tone={i.status === "accepted" ? "ok" : i.status === "declined" ? "bad" : "mute"}>
                            <span className="capitalize">{i.status}</span>
                          </StatusPill>
                          <span className="text-gray-400 w-24 text-right shrink-0">
                            {i.responded_at ? relativeDays(i.responded_at) : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            )}

            {/* ── Folders ────────────────────────────────────────────────── */}
            {tab === "folders" && (
              <Card title="Folders" hint="Filing only — folders never change who can read a document.">
                {isMember && (
                  <div className="flex gap-2 mb-4">
                    <input className={`${input} flex-1`} placeholder="Folder name" value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)} />
                    <button className={primary} disabled={busy === "folder" || !newFolder.trim()}
                      onClick={() => run("folder",
                        () => createFolder(id, newFolder.trim()),
                        () => { setNewFolder(""); load(); })}>
                      Add folder
                    </button>
                  </div>
                )}
                {folders.length === 0 ? (
                  <p className="text-xs text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl px-3 py-10 text-center">
                    No folders yet.
                  </p>
                ) : (
                  <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] divide-y divide-gray-100 dark:divide-gray-800">
                    {folders.map((f) => (
                      <div key={f.id} className="flex items-center gap-3 px-3.5 py-2.5">
                        <Icon className="w-4 h-4 text-gray-400">
                          <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                        </Icon>
                        <span className="text-sm flex-1 truncate">{f.name}</span>
                        {isAdmin && (
                          <button className="text-xs text-red-500 hover:text-red-600"
                            onClick={() => run(`f${f.id}`, () => deleteFolder(id, f.id), load)}>
                            Delete
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
