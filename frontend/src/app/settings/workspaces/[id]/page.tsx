"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import MarkdropLoader from "@/components/MarkdropLoader";
import CopyButton from "@/components/CopyButton";
import {
  can, getWorkspace, updateWorkspace,
  listDomains, addDomain, verifyDomain, attachDomain, removeDomain,
  listMembers, addMember, setMemberRole, removeMember,
  listFolders, createFolder, deleteFolder,
  type Branding, type Domain, type DomainKind, type Folder, type Member,
  type Role, type ViewerChrome, type Workspace, type WorkspaceSettings,
} from "@/lib/workspaces";

const input =
  "bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors";
const primary =
  "px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors";
const ghost =
  "px-3 py-1.5 text-xs rounded-md border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold mb-1">{title}</h2>
      {hint && <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 leading-relaxed">{hint}</p>}
      {children}
    </section>
  );
}

/** One DNS row, formatted to be pasted into a registrar without editing. */
function DnsRow({ label, type, name, value }: { label: string; type: string; name: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-[11px] py-1.5">
      <span className="w-14 shrink-0 text-gray-400 pt-0.5">{label}</span>
      <span className="w-12 shrink-0 font-mono text-gray-500">{type}</span>
      <code className="flex-1 min-w-0 font-mono break-all text-gray-700 dark:text-gray-300">{name}</code>
      <code className="flex-1 min-w-0 font-mono break-all text-gray-700 dark:text-gray-300">{value}</code>
      <CopyButton text={value} label="Copy" />
    </div>
  );
}

export default function WorkspaceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [ws, setWs] = useState<Workspace | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const [branding, setBranding] = useState<Branding | null>(null);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [newHost, setNewHost] = useState("");
  const [newKind, setNewKind] = useState<DomainKind>("app");
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Exclude<Role, "owner">>("member");
  const [newFolder, setNewFolder] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const w = await getWorkspace(id);
      setWs(w);
      setBranding(w.branding);
      setSettings(w.settings);
      // Members and folders need only viewer; domains are fetched the same way
      // and simply come back empty if the API declines.
      const [d, m, f] = await Promise.all([
        listDomains(id).catch(() => []),
        listMembers(id).catch(() => []),
        listFolders(id).catch(() => []),
      ]);
      setDomains(d); setMembers(m); setFolders(f);
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

  const isAdmin = can(ws.role, "admin");
  const isMember = can(ws.role, "member");

  return (
    <div className="flex-1 min-h-0 overflow-y-auto max-w-2xl mx-auto w-full pb-16">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold truncate">{ws.name}</h1>
        <a href="/settings/workspaces" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 shrink-0">← All workspaces</a>
      </div>
      <p className="text-xs text-gray-400 mb-6 capitalize">Your role: {ws.role}</p>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
      {saved && <p className="text-sm text-emerald-600 dark:text-emerald-400 mb-4">{saved}</p>}
      {!isAdmin && (
        <p className="text-xs text-gray-500 border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-2 mb-6">
          You can view this workspace. Changing branding, domains or members needs the admin role.
        </p>
      )}

      {/* ── Branding ─────────────────────────────────────────────────────── */}
      <Section
        title="Branding"
        hint="Applied to link previews, page titles and the favicon on your own domains. Leave blank to use Markdrop's."
      >
        <div className="space-y-2">
          <input className={`${input} w-full`} placeholder="Site name (replaces “Markdrop”)"
            value={branding.site_name ?? ""} disabled={!isAdmin}
            onChange={(e) => setBranding({ ...branding, site_name: e.target.value || null })} />
          <input className={`${input} w-full`} placeholder="Favicon URL (https://…)"
            value={branding.favicon_url ?? ""} disabled={!isAdmin}
            onChange={(e) => setBranding({ ...branding, favicon_url: e.target.value || null })} />
          <div className="flex gap-2 items-center">
            <input className={`${input} flex-1`} placeholder="Accent colour (#3b82f6)"
              value={branding.accent_color ?? ""} disabled={!isAdmin}
              onChange={(e) => setBranding({ ...branding, accent_color: e.target.value || null })} />
            <span className="w-9 h-9 rounded-lg border border-gray-200 dark:border-gray-700 shrink-0"
              style={{ background: branding.accent_color || "transparent" }} aria-hidden />
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 pt-1">
            <input type="checkbox" checked={branding.hide_markdrop_branding} disabled={!isAdmin}
              onChange={(e) => setBranding({ ...branding, hide_markdrop_branding: e.target.checked })}
              className="accent-blue-600" />
            Remove Markdrop from preview cards and titles
          </label>
        </div>
      </Section>

      {/* ── Viewer behaviour ─────────────────────────────────────────────── */}
      <Section
        title="Viewer behaviour"
        hint="Only applies on your own verified domains — never on markdrop.in, where we stay accountable for what's served."
      >
        <div className="space-y-2">
          <select className={`${input} w-full cursor-pointer`} value={settings.viewer_chrome} disabled={!isAdmin}
            onChange={(e) => setSettings({ ...settings, viewer_chrome: e.target.value as ViewerChrome })}>
            <option value="full">Full — visitors can leave full screen and see document details</option>
            <option value="minimal">Minimal</option>
            <option value="none">View only — no controls for signed-out visitors (CDN mode)</option>
          </select>
          <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400">
            <input type="checkbox" checked={settings.require_auth_to_view} disabled={!isAdmin}
              onChange={(e) => setSettings({ ...settings, require_auth_to_view: e.target.checked })}
              className="accent-blue-600 mt-0.5" />
            <span>
              Require sign-in to read this workspace&apos;s documents.
              <span className="block text-gray-400">Enforced everywhere, including markdrop.in links.</span>
            </span>
          </label>
        </div>
        {isAdmin && (
          <button
            className={`${primary} mt-3`}
            disabled={busy === "save"}
            onClick={() => run("save",
              () => updateWorkspace(id, { branding, settings }),
              () => { setSaved("Saved."); load(); })}
          >
            {busy === "save" ? "Saving…" : "Save branding & behaviour"}
          </button>
        )}
      </Section>

      {/* ── Domains ──────────────────────────────────────────────────────── */}
      <Section
        title="Domains"
        hint="Any hostname you control. “Documents” serves pages and sign-in; “Files only” serves uploaded artifacts and never runs the app — one host can't do both."
      >
        {isAdmin && (
          <div className="flex gap-2 mb-3">
            <input className={`${input} flex-1`} placeholder="docs.yourcompany.com"
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
              Add
            </button>
          </div>
        )}

        {domains.length === 0 ? (
          <p className="text-xs text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg px-3 py-6 text-center">
            No domains yet.
          </p>
        ) : (
          <div className="space-y-3">
            {domains.map((d) => (
              <div key={d.id} className="border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-xl p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-sm font-mono">{d.host}</code>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">
                    {d.kind === "app" ? "Documents" : "Files only"}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    d.status === "verified"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"}`}>
                    {d.status === "verified" ? "Verified" : "Awaiting DNS"}
                  </span>
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
                  <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                    <p className="text-[11px] text-gray-500 mb-1">Add both records at your DNS provider, then Check DNS.</p>
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
      </Section>

      {/* ── Members ──────────────────────────────────────────────────────── */}
      <Section title="Members" hint="They need a Markdrop account first — sign-in creates it.">
        {isAdmin && (
          <div className="flex gap-2 mb-3">
            <input className={`${input} flex-1`} placeholder="person@company.com" type="email"
              value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <select className={`${input} cursor-pointer`} value={newRole}
              onChange={(e) => setNewRole(e.target.value as Exclude<Role, "owner">)}>
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button className={primary} disabled={busy === "member" || !newEmail.trim()}
              onClick={() => run("member",
                () => addMember(id, newEmail.trim(), newRole),
                () => { setNewEmail(""); load(); })}>
              Add
            </button>
          </div>
        )}
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] divide-y divide-gray-100 dark:divide-gray-800">
          {members.map((m) => (
            <div key={m.user_id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{m.name || m.email}</p>
                {m.name && <p className="text-[11px] text-gray-400 truncate">{m.email}</p>}
              </div>
              {m.user_id === ws.owner_id ? (
                <span className="text-[11px] text-gray-400 px-2">Owner</span>
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
                <span className="text-[11px] text-gray-400 px-2 capitalize">{m.role}</span>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* ── Folders ──────────────────────────────────────────────────────── */}
      <Section title="Folders" hint="Filing only — folders never change who can read a document.">
        {isMember && (
          <div className="flex gap-2 mb-3">
            <input className={`${input} flex-1`} placeholder="Folder name" value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)} />
            <button className={primary} disabled={busy === "folder" || !newFolder.trim()}
              onClick={() => run("folder",
                () => createFolder(id, newFolder.trim()),
                () => { setNewFolder(""); load(); })}>
              Add
            </button>
          </div>
        )}
        {folders.length === 0 ? (
          <p className="text-xs text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg px-3 py-6 text-center">
            No folders yet.
          </p>
        ) : (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] divide-y divide-gray-100 dark:divide-gray-800">
            {folders.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-3 py-2.5">
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
      </Section>
    </div>
  );
}
