"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MarkdownPreview from "@/components/MarkdownPreview";
import {
  AdminDocListItem,
  adminDeleteDocument,
  adminGetDocument,
  adminListDocuments,
  adminLogin,
  adminUpdateDocument,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
} from "@/lib/api";

type Phase = "init" | "login" | "dashboard" | "editing";
type EditMode = "edit" | "split" | "preview";

export default function AdminApp() {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("init");
  const [token, setToken] = useState<string | null>(null);

  // ── Login ───────────────────────────────────────────────────────────────────
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // ── Dashboard ───────────────────────────────────────────────────────────────
  const [docs, setDocs] = useState<AdminDocListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState("");
  const [dashLoading, setDashLoading] = useState(false);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // ── Editor ──────────────────────────────────────────────────────────────────
  const [editSlug, setEditSlug] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editMode, setEditMode] = useState<EditMode>("split");
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveDone, setSaveDone] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Init ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const stored = getAdminToken();
    if (stored) {
      setToken(stored);
      setPhase("dashboard");
    } else {
      setPhase("login");
    }
  }, []);

  // ── Load documents ───────────────────────────────────────────────────────────
  const loadDocs = useCallback(
    async (tok: string, pg = 1, q = "") => {
      setDashLoading(true);
      try {
        const res = await adminListDocuments(tok, pg, 20, q || undefined);
        setDocs(res.documents);
        setTotal(res.total);
        setPage(res.page);
        setPages(res.pages);
      } catch (e: unknown) {
        if (e instanceof Error && e.message === "UNAUTHORIZED") {
          clearAdminToken();
          setToken(null);
          setPhase("login");
        }
      } finally {
        setDashLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (phase === "dashboard" && token) {
      loadDocs(token, 1, search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  // ── Search with debounce ──────────────────────────────────────────────────────
  const handleSearch = (val: string) => {
    setSearch(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (token) loadDocs(token, 1, val);
    }, 400);
  };

  // ── Login ─────────────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const { token: tok } = await adminLogin(username, password);
      setAdminToken(tok);
      setToken(tok);
      setPhase("dashboard");
    } catch {
      setLoginError("Invalid username or password");
    } finally {
      setLoginLoading(false);
    }
  };

  // ── Logout ────────────────────────────────────────────────────────────────────
  const handleLogout = () => {
    clearAdminToken();
    setToken(null);
    setUsername("");
    setPassword("");
    setPhase("login");
  };

  // ── Open editor ───────────────────────────────────────────────────────────────
  const handleEdit = async (slug: string) => {
    if (!token) return;
    try {
      const doc = await adminGetDocument(token, slug);
      setEditSlug(doc.slug);
      setEditTitle(doc.title ?? "");
      setEditContent(doc.content);
      setSaveError(null);
      setSaveDone(false);
      setPhase("editing");
    } catch (e: unknown) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") handleLogout();
    }
  };

  // ── Save ──────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!token || !editSlug) return;
    setSaveLoading(true);
    setSaveError(null);
    setSaveDone(false);
    try {
      await adminUpdateDocument(token, editSlug, editTitle, editContent);
      setSaveDone(true);
      setTimeout(() => setSaveDone(false), 2500);
    } catch {
      setSaveError("Failed to save — please try again");
    } finally {
      setSaveLoading(false);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────────
  const handleDelete = async (slug: string) => {
    if (!token) return;
    if (confirmDelete !== slug) {
      setConfirmDelete(slug);
      return;
    }
    setDeletingSlug(slug);
    setConfirmDelete(null);
    try {
      await adminDeleteDocument(token, slug);
      if (token) loadDocs(token, page, search);
    } catch {
      // silently ignore
    } finally {
      setDeletingSlug(null);
    }
  };

  const handleBackToDashboard = () => {
    setPhase("dashboard");
    if (token) loadDocs(token, page, search);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Render: Init spinner
  // ─────────────────────────────────────────────────────────────────────────────
  if (phase === "init") {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render: Login
  // ─────────────────────────────────────────────────────────────────────────────
  if (phase === "login") {
    return (
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          {/* Icon + title */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] mb-4">
              <svg
                className="w-7 h-7 text-gray-600 dark:text-gray-300 vscode:text-[#d4d4d4]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50 vscode:text-[#d4d4d4]">
              Admin
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mt-1">
              Sign in to manage documents
            </p>
          </div>

          <form
            onSubmit={handleLogin}
            className="space-y-4 p-6 rounded-2xl border border-gray-200 dark:border-gray-700/70 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900/40 vscode:bg-[#252526]"
          >
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] mb-1.5">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900 vscode:bg-[#1e1e1e] text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900 vscode:bg-[#1e1e1e] text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {loginError && (
              <p className="text-xs text-red-500 dark:text-red-400">{loginError}</p>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
            >
              {loginLoading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render: Editor
  // ─────────────────────────────────────────────────────────────────────────────
  if (phase === "editing") {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-3 py-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-4 shrink-0">
          <button
            onClick={handleBackToDashboard}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] hover:text-gray-800 dark:hover:text-gray-200 vscode:hover:text-[#d4d4d4] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Dashboard
          </button>

          <div className="flex items-center gap-2">
            <span className="hidden sm:block text-xs font-mono text-gray-400 dark:text-gray-500 vscode:text-[#6e6e6e]">
              {editSlug}
            </span>

            {/* Mode toggle */}
            <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] text-xs">
              {(["edit", "split", "preview"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setEditMode(m)}
                  className={`px-3 py-1.5 capitalize transition-colors ${
                    editMode === m
                      ? "bg-blue-600 text-white"
                      : "text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d] hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d]"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Open in new tab */}
            <a
              href={`/${editSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 vscode:hover:text-[#d4d4d4] transition-colors"
              title="Open document"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </a>

            <button
              onClick={handleSave}
              disabled={saveLoading}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                saveDone
                  ? "bg-green-600 hover:bg-green-500 text-white"
                  : "bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
              }`}
            >
              {saveLoading ? "Saving…" : saveDone ? "Saved ✓" : "Save"}
            </button>
          </div>
        </div>

        {saveError && (
          <p className="text-xs text-red-500 dark:text-red-400 shrink-0">{saveError}</p>
        )}

        {/* Title */}
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          placeholder="Untitled"
          className="shrink-0 w-full px-3 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-transparent text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        {/* Editor panes */}
        <div className="flex-1 min-h-0 flex gap-3">
          {(editMode === "edit" || editMode === "split") && (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="flex-1 h-full resize-none p-3 text-sm font-mono rounded-xl border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#1e1e1e] text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] focus:outline-none focus:ring-2 focus:ring-blue-500"
              spellCheck={false}
            />
          )}
          {(editMode === "preview" || editMode === "split") && (
            <div className="flex-1 overflow-y-auto p-4 rounded-xl border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900/20 vscode:bg-[#1e1e1e]">
              <MarkdownPreview content={editContent} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render: Dashboard
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="py-4 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-50 vscode:text-[#d4d4d4]">
            Admin Dashboard
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mt-0.5">
            {total.toLocaleString()} document{total !== 1 ? "s" : ""} total
          </p>
        </div>
        <button
          onClick={handleLogout}
          className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] hover:text-red-500 dark:hover:text-red-400 transition-colors"
        >
          Sign out
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          type="text"
          placeholder="Search by slug, title, or content…"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/50 vscode:bg-[#252526] text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Table */}
      {dashLoading ? (
        <div className="flex justify-center py-16">
          <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </div>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
          {search ? "No documents match your search." : "No documents yet."}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/50 vscode:bg-[#252526]">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] uppercase tracking-wider">
                  Slug
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] uppercase tracking-wider">
                  Title
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] uppercase tracking-wider">
                  Views
                </th>
                <th className="hidden md:table-cell text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] uppercase tracking-wider">
                  Created
                </th>
                <th className="hidden lg:table-cell text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] uppercase tracking-wider">
                  Expiry
                </th>
                <th className="hidden lg:table-cell text-right px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] uppercase tracking-wider">
                  Chars
                </th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody>
              {docs.map((doc, i) => {
                const isExpired =
                  doc.expires_at != null && new Date(doc.expires_at) < new Date();
                const isConfirming = confirmDelete === doc.slug;
                const isDeleting = deletingSlug === doc.slug;

                return (
                  <tr
                    key={doc.slug}
                    onClick={() => {
                      if (confirmDelete && confirmDelete !== doc.slug) {
                        setConfirmDelete(null);
                      }
                    }}
                    className={`border-b last:border-0 border-gray-100 dark:border-gray-800 vscode:border-[#3c3c3c] ${
                      i % 2 === 0
                        ? "bg-white dark:bg-transparent vscode:bg-transparent"
                        : "bg-gray-50/50 dark:bg-gray-900/20 vscode:bg-[#252526]/40"
                    }`}
                  >
                    {/* Slug */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {doc.is_password_protected && (
                          <svg
                            className="w-3 h-3 text-amber-500 shrink-0"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                        <a
                          href={`/${doc.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-blue-500 dark:text-blue-400 vscode:text-[#4fc1ff] hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {doc.slug}
                        </a>
                      </div>
                    </td>

                    {/* Title */}
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-xs text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] truncate">
                        {doc.title ?? (
                          <span className="italic text-gray-400 dark:text-gray-600 vscode:text-[#6e6e6e]">
                            Untitled
                          </span>
                        )}
                      </p>
                    </td>

                    {/* Views */}
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                        {doc.views.toLocaleString()}
                      </span>
                    </td>

                    {/* Created */}
                    <td className="hidden md:table-cell px-4 py-3">
                      <span className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                        {new Date(doc.created_at).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </td>

                    {/* Expiry */}
                    <td className="hidden lg:table-cell px-4 py-3">
                      {doc.expires_at ? (
                        <span
                          className={`text-xs font-medium ${
                            isExpired
                              ? "text-red-500 dark:text-red-400"
                              : "text-green-600 dark:text-green-400"
                          }`}
                        >
                          {isExpired
                            ? "Expired"
                            : new Date(doc.expires_at).toLocaleDateString("en-GB", {
                                day: "2-digit",
                                month: "short",
                                year: "numeric",
                              })}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-gray-600 vscode:text-[#6e6e6e]">
                          Never
                        </span>
                      )}
                    </td>

                    {/* Chars */}
                    <td className="hidden lg:table-cell px-4 py-3 text-right">
                      <span className="text-xs tabular-nums text-gray-400 dark:text-gray-600 vscode:text-[#6e6e6e]">
                        {doc.content_length.toLocaleString()}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {/* Edit */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEdit(doc.slug);
                          }}
                          className="p-1.5 rounded text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 vscode:hover:bg-blue-900/20 transition-colors"
                          title="Edit document"
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"
                            />
                          </svg>
                        </button>

                        {/* Delete */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(doc.slug);
                          }}
                          disabled={isDeleting}
                          className={`p-1.5 rounded transition-colors ${
                            isConfirming
                              ? "bg-red-500 hover:bg-red-600 text-white"
                              : "text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 vscode:hover:bg-red-900/20"
                          }`}
                          title={isConfirming ? "Click again to confirm" : "Delete document"}
                        >
                          {isDeleting ? (
                            <div className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                          ) : isConfirming ? (
                            <span className="text-[10px] font-semibold px-0.5 leading-none">Sure?</span>
                          ) : (
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                              />
                            </svg>
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
            Page {page} of {pages} · {total.toLocaleString()} documents
          </p>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => {
                const p = page - 1;
                setPage(p);
                if (token) loadDocs(token, p, search);
              }}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-600 dark:text-gray-300 vscode:text-[#d4d4d4] transition-colors"
            >
              ← Prev
            </button>
            <button
              disabled={page >= pages}
              onClick={() => {
                const p = page + 1;
                setPage(p);
                if (token) loadDocs(token, p, search);
              }}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-600 dark:text-gray-300 vscode:text-[#d4d4d4] transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
