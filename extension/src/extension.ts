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
  };
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
  const res = await api("POST", "/api/v1/sync", { title: deriveTitle(text, uri), content: normalize(text) });
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
    await resolveConflict(document, link, detail, h);
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

// One-way phase: give the user control instead of silently overwriting.
// (Phase C will replace this with a proper side-by-side diff merge.)
async function resolveConflict(
  document: vscode.TextDocument,
  link: Link,
  remote: ConflictDetail,
  localHash: string
) {
  statusBar.text = "$(warning) Markdrop: conflict";
  const choice = await vscode.window.showWarningMessage(
    "The Markdrop web copy changed since your last sync.",
    { modal: true },
    "Overwrite web with local",
    "Replace local with web"
  );
  if (choice === "Overwrite web with local") {
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
      vscode.window.showErrorMessage("Couldn't overwrite — try again.");
    }
  } else if (choice === "Replace local with web") {
    await fs.writeFile(document.uri.fsPath, normalize(remote.content), "utf8");
    await setLink(document.uri, { ...link, slug: remote.slug, baseRev: remote.rev, baseHash: hash(remote.content) });
    vscode.window.showInformationMessage("Replaced local file with the Markdrop version.");
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

async function unlink() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  await deleteLink(editor.document.uri);
  vscode.window.showInformationMessage("Unlinked from Markdrop (the web document is untouched).");
  updateStatus();
}

// ── Activation ────────────────────────────────────────────────────────────────
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
      if (ed) await pushDocument(ed.document);
    }),
    vscode.commands.registerCommand("markdrop.openInBrowser", openInBrowser),
    vscode.commands.registerCommand("markdrop.unlink", unlink),
    vscode.window.registerUriHandler({ handleUri }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "markdown" && cfg().pushOnSave) schedulePush(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) updateStatus();
    })
  );

  updateStatus();
}

export function deactivate() {
  for (const t of debounceTimers.values()) clearTimeout(t);
}
