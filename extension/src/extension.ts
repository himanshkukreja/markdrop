import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs/promises";

// ── Module state ────────────────────────────────────────────────────────────
let ctx: vscode.ExtensionContext;
let statusBar: vscode.StatusBarItem;
let pendingAuthState: string | undefined;
const debounceTimers = new Map<string, NodeJS.Timeout>();
const TOKEN_KEY = "markdrop.token";

interface Link {
  id: string;
  slug: string;
  baseRev: number;
  baseHash: string;
}

interface SyncDoc {
  id: string;
  slug: string;
  url: string;
  title: string | null;
  content: string;
  rev: number;
  updated_at: string;
}
interface Me { email: string }
interface ConflictDetail { rev: number; content: string; slug: string }

// ── Config ──────────────────────────────────────────────────────────────────
function cfg() {
  const c = vscode.workspace.getConfiguration("markdrop");
  return {
    apiUrl: (c.get<string>("apiUrl") || "https://api.markdrop.in").replace(/\/$/, ""),
    webUrl: (c.get<string>("webUrl") || "https://markdrop.in").replace(/\/$/, ""),
    pushOnSave: c.get<boolean>("pushOnSave") ?? true,
    autoPull: c.get<boolean>("autoPull") ?? true,
    pollSeconds: Math.max(5, c.get<number>("pollSeconds") ?? 10),
  };
}

// ── Remote content provider (for the conflict diff view) ──────────────────────
const REMOTE_SCHEME = "markdrop-remote";
const remoteCache = new Map<string, string>(); // docId -> remote content
const remoteEmitter = new vscode.EventEmitter<vscode.Uri>();
const remoteProvider: vscode.TextDocumentContentProvider = {
  onDidChange: remoteEmitter.event,
  provideTextDocumentContent: (uri) => remoteCache.get(uri.path.replace(/^\//, "")) ?? "",
};
function remoteUri(link: Link): vscode.Uri {
  return vscode.Uri.parse(`${REMOTE_SCHEME}:/${link.id}/${link.slug}.md (Markdrop web)`);
}

// ── Auth token (SecretStorage) ────────────────────────────────────────────────
const getToken = () => ctx.secrets.get(TOKEN_KEY);
const setToken = (t: string) => ctx.secrets.store(TOKEN_KEY, t);
const clearToken = () => ctx.secrets.delete(TOKEN_KEY);

// ── HTTP ──────────────────────────────────────────────────────────────────────
async function api(method: string, apiPath: string, body?: unknown): Promise<Response> {
  const token = await getToken();
  return fetch(cfg().apiUrl + apiPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Content helpers ────────────────────────────────────────────────────────────
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "") + "\n";
}
function hash(text: string): string {
  return crypto.createHash("sha256").update(normalize(text)).digest("hex");
}
function deriveTitle(text: string, uri: vscode.Uri): string {
  const m = text.match(/^\s*#\s+(.+?)\s*$/m);
  if (m) return m[1].slice(0, 200);
  return path.basename(uri.fsPath).replace(/\.mdx?$/i, "");
}

// ── Link store (.markdrop.json per workspace folder; globalState fallback) ──────
function folderOf(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri);
}
function linkFilePath(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, ".markdrop.json");
}
async function readLinkFile(folder: vscode.WorkspaceFolder): Promise<Record<string, Link>> {
  try {
    const raw = await fs.readFile(linkFilePath(folder), "utf8");
    return JSON.parse(raw).links ?? {};
  } catch {
    return {};
  }
}
async function writeLinkFile(folder: vscode.WorkspaceFolder, links: Record<string, Link>) {
  await fs.writeFile(linkFilePath(folder), JSON.stringify({ version: 1, links }, null, 2) + "\n", "utf8");
}
function globalKey(uri: vscode.Uri): string {
  return `link:${uri.fsPath}`;
}

async function getLink(uri: vscode.Uri): Promise<Link | undefined> {
  const folder = folderOf(uri);
  if (folder) {
    const links = await readLinkFile(folder);
    return links[path.relative(folder.uri.fsPath, uri.fsPath)];
  }
  return ctx.globalState.get<Link>(globalKey(uri));
}
async function setLink(uri: vscode.Uri, link: Link) {
  const folder = folderOf(uri);
  if (folder) {
    const links = await readLinkFile(folder);
    links[path.relative(folder.uri.fsPath, uri.fsPath)] = link;
    await writeLinkFile(folder, links);
  } else {
    await ctx.globalState.update(globalKey(uri), link);
  }
}
async function deleteLink(uri: vscode.Uri) {
  const folder = folderOf(uri);
  if (folder) {
    const links = await readLinkFile(folder);
    delete links[path.relative(folder.uri.fsPath, uri.fsPath)];
    await writeLinkFile(folder, links);
  } else {
    await ctx.globalState.update(globalKey(uri), undefined);
  }
}

// ── Status bar ──────────────────────────────────────────────────────────────
async function updateStatus() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    statusBar.hide();
    return;
  }
  statusBar.show();
  const signedIn = !!(await getToken());
  if (!signedIn) {
    statusBar.text = "$(cloud) Markdrop: sign in";
    statusBar.command = "markdrop.signIn";
    statusBar.tooltip = "Sign in to Markdrop";
    return;
  }
  const link = await getLink(editor.document.uri);
  if (!link) {
    statusBar.text = "$(cloud-upload) Publish to Markdrop";
    statusBar.command = "markdrop.publish";
    statusBar.tooltip = "Publish this file to Markdrop";
    return;
  }
  const dirty = hash(editor.document.getText()) !== link.baseHash;
  statusBar.text = dirty ? "$(sync) Markdrop: unsynced" : "$(check) Markdrop: synced";
  statusBar.command = "markdrop.openInBrowser";
  statusBar.tooltip = `${cfg().webUrl}/${link.slug} (rev ${link.baseRev})`;
}

function setBusy(text: string) {
  statusBar.text = text;
  statusBar.show();
}

// ── Auth flows ────────────────────────────────────────────────────────────────
async function signIn() {
  pendingAuthState = crypto.randomBytes(16).toString("hex");
  const redirect = `${vscode.env.uriScheme}://${ctx.extension.id}/auth`;
  const url = `${cfg().webUrl}/extension/authorize?state=${pendingAuthState}&redirect=${encodeURIComponent(redirect)}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
  vscode.window.showInformationMessage("Complete sign-in in your browser, then return to VS Code.");
}

async function signInWithToken() {
  const token = await vscode.window.showInputBox({
    prompt: "Paste your Markdrop API token (create one at markdrop.in → API tokens)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "mdk_…",
  });
  if (!token) return;
  await setToken(token.trim());
  const res = await api("GET", "/api/v1/auth/me");
  if (!res.ok) {
    await clearToken();
    vscode.window.showErrorMessage("That token didn't work. Please try again.");
    return;
  }
  const me = await res.json() as Me;
  vscode.window.showInformationMessage(`Signed in to Markdrop as ${me.email}.`);
  updateStatus();
}

async function handleUri(uri: vscode.Uri) {
  if (uri.path !== "/auth") return;
  const params = new URLSearchParams(uri.query);
  const token = params.get("token");
  const state = params.get("state");
  if (!token) return;
  if (pendingAuthState && state !== pendingAuthState) {
    vscode.window.showErrorMessage("Markdrop sign-in failed: state mismatch.");
    return;
  }
  pendingAuthState = undefined;
  await setToken(token);
  const res = await api("GET", "/api/v1/auth/me");
  const me = res.ok ? (await res.json() as Me) : null;
  vscode.window.showInformationMessage(me ? `Signed in to Markdrop as ${me.email}.` : "Signed in to Markdrop.");
  updateStatus();
}

async function ensureSignedIn(): Promise<boolean> {
  if (await getToken()) return true;
  const pick = await vscode.window.showInformationMessage(
    "Sign in to Markdrop first.", "Sign in", "Paste token"
  );
  if (pick === "Sign in") await signIn();
  else if (pick === "Paste token") await signInWithToken();
  return !!(await getToken());
}

// ── Sync ────────────────────────────────────────────────────────────────────
async function publish() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    vscode.window.showWarningMessage("Open a Markdown file to publish.");
    return;
  }
  if (!(await ensureSignedIn())) return;

  const uri = editor.document.uri;
  const existing = await getLink(uri);
  if (existing) {
    vscode.window.showInformationMessage("This file is already linked to Markdrop.");
    return;
  }
  const text = editor.document.getText();
  setBusy("$(sync~spin) Markdrop: publishing…");
  const res = await api("POST", "/api/v1/sync", {
    title: deriveTitle(text, uri),
    content: normalize(text),
    desired_slug: path.basename(uri.fsPath), // server slugifies + de-dupes
  });
  if (res.status === 401) { await clearToken(); vscode.window.showErrorMessage("Session expired — sign in again."); updateStatus(); return; }
  if (!res.ok) { vscode.window.showErrorMessage("Failed to publish to Markdrop."); updateStatus(); return; }
  const doc = await res.json() as SyncDoc;
  await setLink(uri, { id: doc.id, slug: doc.slug, baseRev: doc.rev, baseHash: hash(text) });
  updateStatus();
  const action = await vscode.window.showInformationMessage(`Published to ${doc.url}`, "Open in browser", "Copy link");
  if (action === "Open in browser") vscode.env.openExternal(vscode.Uri.parse(doc.url));
  else if (action === "Copy link") vscode.env.clipboard.writeText(doc.url);
}

async function pushDocument(document: vscode.TextDocument, { silent = false } = {}) {
  const uri = document.uri;
  const link = await getLink(uri);
  if (!link) return;
  if (!(await getToken())) return;

  const text = document.getText();
  const h = hash(text);
  if (h === link.baseHash) return; // nothing changed

  setBusy("$(sync~spin) Markdrop: syncing…");
  const res = await api("PUT", `/api/v1/sync/${link.id}`, {
    content: normalize(text),
    title: deriveTitle(text, uri),
    base_rev: link.baseRev,
  });

  if (res.status === 404) {
    await deleteLink(uri);
    vscode.window.showWarningMessage("This document no longer exists on Markdrop — unlinked.");
    updateStatus();
    return;
  }
  if (res.status === 401) {
    await clearToken();
    vscode.window.showErrorMessage("Session expired — sign in again.");
    updateStatus();
    return;
  }
  if (res.status === 409) {
    const detail = (await res.json() as { detail: ConflictDetail }).detail;
    await showConflict(document, link, detail);
    return;
  }
  if (!res.ok) {
    if (!silent) vscode.window.showErrorMessage("Markdrop sync failed.");
    updateStatus();
    return;
  }
  const doc = await res.json() as SyncDoc;
  await setLink(uri, { ...link, slug: doc.slug, baseRev: doc.rev, baseHash: h });
  updateStatus();
}

// Write remote content to the local file and mark it in sync.
async function applyRemote(uri: vscode.Uri, link: Link, remote: ConflictDetail) {
  const content = normalize(remote.content);
  await fs.writeFile(uri.fsPath, content, "utf8");
  await setLink(uri, { ...link, slug: remote.slug, baseRev: remote.rev, baseHash: hash(content) });
}

// Two-way conflict: both local and web changed. Open a side-by-side diff and
// let the user choose. "Merge" rebases the local edit onto the web revision so
// the next save pushes cleanly.
async function showConflict(document: vscode.TextDocument, link: Link, remote: ConflictDetail) {
  statusBar.text = "$(warning) Markdrop: conflict";
  statusBar.show();

  // Show the differences (local ↔ web) in a diff editor.
  remoteCache.set(link.id, normalize(remote.content));
  const rUri = remoteUri({ ...link, slug: remote.slug });
  remoteEmitter.fire(rUri);
  await vscode.commands.executeCommand("vscode.diff", rUri, document.uri, "Markdrop (web) ↔ Local");

  const choice = await vscode.window.showWarningMessage(
    "This document changed both on Markdrop and locally.",
    { modal: true, detail: "The diff shows web (left) vs local (right)." },
    "Keep my local version",
    "Use the web version",
    "Merge manually"
  );

  if (choice === "Keep my local version") {
    const localHash = hash(document.getText());
    const res = await api("PUT", `/api/v1/sync/${link.id}`, {
      content: normalize(document.getText()),
      title: deriveTitle(document.getText(), document.uri),
      base_rev: remote.rev,
    });
    if (res.ok) {
      const doc = await res.json() as SyncDoc;
      await setLink(document.uri, { ...link, slug: doc.slug, baseRev: doc.rev, baseHash: localHash });
      vscode.window.showInformationMessage("Pushed your local version to Markdrop.");
    } else {
      vscode.window.showErrorMessage("Couldn't push — try again.");
    }
  } else if (choice === "Use the web version") {
    await applyRemote(document.uri, link, remote);
    vscode.window.showInformationMessage("Replaced local file with the Markdrop version.");
  } else if (choice === "Merge manually") {
    // Rebase onto the web rev: keep local content (still "dirty"), but base the
    // next push on the web revision so saving your merged result succeeds.
    await setLink(document.uri, { ...link, slug: remote.slug, baseRev: remote.rev });
    vscode.window.showInformationMessage("Edit to merge using the diff, then save to push your merged version.");
  }
  updateStatus();
}

function schedulePush(document: vscode.TextDocument) {
  const key = document.uri.fsPath;
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    pushDocument(document, { silent: true });
  }, 800));
}

async function openInBrowser() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const link = await getLink(editor.document.uri);
  if (!link) { vscode.window.showInformationMessage("This file isn't linked to Markdrop yet."); return; }
  vscode.env.openExternal(vscode.Uri.parse(`${cfg().webUrl}/${link.slug}`));
}

// Poll the active linked document for remote changes (two-way pull).
let polling = false;
async function pollActive() {
  if (polling) return;
  if (!cfg().autoPull || !vscode.window.state.focused) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") return;
  const uri = editor.document.uri;
  const link = await getLink(uri);
  if (!link || !(await getToken())) return;

  polling = true;
  try {
    const res = await api("GET", `/api/v1/sync/${link.id}/rev`);
    if (res.status === 404) { await deleteLink(uri); updateStatus(); return; }
    if (!res.ok) return;
    const { rev } = await res.json() as { rev: number };
    if (rev <= link.baseRev) return; // nothing new on the server

    // Remote advanced — fetch full content.
    const full = await api("GET", `/api/v1/sync/${link.id}`);
    if (!full.ok) return;
    const doc = await full.json() as SyncDoc;
    const remote: ConflictDetail = { rev: doc.rev, content: doc.content, slug: doc.slug };

    if (hash(editor.document.getText()) === link.baseHash) {
      // Local is clean → fast-forward pull.
      await applyRemote(uri, link, remote);
      updateStatus();
    } else {
      // Local also changed → conflict.
      await showConflict(editor.document, link, remote);
    }
  } finally {
    polling = false;
  }
}

async function unlink() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  await deleteLink(editor.document.uri);
  vscode.window.showInformationMessage("Unlinked from Markdrop (the web document is untouched).");
  updateStatus();
}

// ── Activation ────────────────────────────────────────────────────────────────
let pollInterval: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("markdrop.signIn", signIn),
    vscode.commands.registerCommand("markdrop.signInWithToken", signInWithToken),
    vscode.commands.registerCommand("markdrop.signOut", async () => { await clearToken(); vscode.window.showInformationMessage("Signed out of Markdrop."); updateStatus(); }),
    vscode.commands.registerCommand("markdrop.publish", publish),
    vscode.commands.registerCommand("markdrop.syncNow", async () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) { await pushDocument(ed.document); await pollActive(); }
    }),
    vscode.commands.registerCommand("markdrop.openInBrowser", openInBrowser),
    vscode.commands.registerCommand("markdrop.unlink", unlink),
    vscode.window.registerUriHandler({ handleUri }),
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, remoteProvider),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "markdown" && cfg().pushOnSave) schedulePush(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => { updateStatus(); pollActive(); }),
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) pollActive(); }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) updateStatus();
    })
  );

  // Background poll for remote → local changes.
  pollInterval = setInterval(() => { pollActive(); }, cfg().pollSeconds * 1000);
  updateStatus();
  pollActive();
}

export function deactivate() {
  for (const t of debounceTimers.values()) clearTimeout(t);
  if (pollInterval) clearInterval(pollInterval);
}
