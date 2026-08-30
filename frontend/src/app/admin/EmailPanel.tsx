"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";
import {
  createCampaign,
  listCampaigns,
  previewAudience,
  sendCampaignTest,
  type Audience,
  type CampaignItem,
} from "@/lib/api";
import { ARTIFACTS_ANNOUNCEMENT } from "./emailTemplates";
import RecipientPicker from "./RecipientPicker";
import SendPreview from "./SendPreview";

const AUDIENCES: { id: Audience; label: string; hint: string }[] = [
  { id: "all", label: "Everyone", hint: "All accounts that haven't opted out" },
  { id: "with_documents", label: "Has documents", hint: "Published at least one doc" },
  { id: "with_artifacts", label: "Uses artifacts", hint: "Published at least one artifact" },
  { id: "recent", label: "Recent signups", hint: "Joined in the last N days" },
  { id: "custom", label: "Specific people", hint: "Paste addresses, one per line" },
];

const STATUS_STYLE: Record<string, string> = {
  sent: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/25",
  sending: "bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-blue-500/25",
  queued: "bg-gray-500/10 text-gray-600 dark:text-gray-400 ring-gray-500/25",
  partial: "bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/25",
};

export default function EmailPanel({ token }: { token: string }) {
  const [subject, setSubject] = useState(ARTIFACTS_ANNOUNCEMENT.subject);
  const [html, setHtml] = useState(ARTIFACTS_ANNOUNCEMENT.html);
  const [sender, setSender] = useState("");
  const [audience, setAudience] = useState<Audience>("all");
  const [recentDays, setRecentDays] = useState(30);
  const [picked, setPicked] = useState<string[]>([]);

  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<string[]>([]);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<null | "test" | "send">(null);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [preview, setPreview] = useState<null | "send" | "test">(null);
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);

  const emails = picked;

  const refreshCount = useCallback(async () => {
    try {
      const r = await previewAudience(token, audience, { recentDays, emails });
      setCount(r.count);
      setSample(r.sample);
    } catch {
      setCount(null);
    }
  }, [token, audience, recentDays, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(refreshCount, 300);
    return () => clearTimeout(t);
  }, [refreshCount]);

  const loadCampaigns = useCallback(async () => {
    try {
      setCampaigns(await listCampaigns(token));
    } catch {
      /* non-fatal */
    }
  }, [token]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  // While anything is mid-flight, poll so progress moves without a manual refresh.
  const sendingRef = useRef(false);
  sendingRef.current = campaigns.some((c) => c.status === "sending" || c.status === "queued");
  useEffect(() => {
    if (!sendingRef.current) return;
    const iv = setInterval(loadCampaigns, 3000);
    return () => clearInterval(iv);
  }, [campaigns, loadCampaigns]);

  async function handleTest() {
    setPreview(null);
    if (!testTo.trim()) return setNote({ kind: "err", text: "Enter an address to send the test to." });
    setBusy("test");
    setNote(null);
    try {
      await sendCampaignTest(token, { subject, html, sender, toEmail: testTo.trim() });
      setNote({ kind: "ok", text: `Test sent to ${testTo.trim()}.` });
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setBusy(null);
    }
  }

  async function handleSend() {
    setPreview(null);
    setBusy("send");
    setNote(null);
    try {
      const r = await createCampaign(token, { subject, html, sender, audience, recentDays, emails });
      setNote({ kind: "ok", text: `Sending to ${r.total} recipient${r.total === 1 ? "" : "s"}…` });
      loadCampaigns();
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : "Could not start the campaign" });
    } finally {
      setBusy(null);
    }
  }

  const input =
    "w-full text-sm bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 outline-none focus:border-blue-500 transition-colors";
  const label = "block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5";

  return (
    <div className="mt-5 space-y-5">
      <div className="grid lg:grid-cols-2 gap-5">
        {/* ── Compose ─────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div>
            <label className={label}>Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={input} />
          </div>

          <div>
            <label className={label}>
              From <span className="text-gray-400">(blank uses updates@ — kept separate from sign-in mail)</span>
            </label>
            <input
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              placeholder="Markdrop &lt;updates@markdrop.in&gt;"
              className={input}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className={label + " mb-0"}>HTML</span>
              <button
                onClick={() => { setSubject(ARTIFACTS_ANNOUNCEMENT.subject); setHtml(ARTIFACTS_ANNOUNCEMENT.html); }}
                className="text-[11px] text-blue-500 hover:underline"
              >
                Load the Artifacts announcement
              </button>
            </div>
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
              className={`${input} h-72 font-mono text-xs resize-none`}
            />
            <p className="mt-1.5 text-[11px] text-gray-400">
              Placeholders: <code>{"{{name}}"}</code> <code>{"{{email}}"}</code>{" "}
              <code>{"{{unsubscribe_url}}"}</code> — an unsubscribe footer is appended
              automatically if you don&apos;t place one.
            </p>
          </div>
        </div>

        {/* ── Live preview ────────────────────────────────────────────── */}
        <div>
          <label className={label}>Preview</label>
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] overflow-hidden bg-white h-[27rem]">
            <iframe
              // Sandboxed with no allow-scripts: this is pasted markup and the
              // admin session lives on this origin.
              sandbox=""
              srcDoc={html}
              title="Email preview"
              className="w-full h-full border-0"
            />
          </div>
        </div>
      </div>

      {/* ── Audience ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {AUDIENCES.map((a) => (
            <button
              key={a.id}
              onClick={() => setAudience(a.id)}
              title={a.hint}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                audience === a.id
                  ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "border-gray-200 dark:border-gray-700 text-gray-500 hover:border-blue-400"
              }`}
            >
              {a.label}
            </button>
          ))}
          <span className="ml-auto text-sm tabular-nums text-gray-600 dark:text-gray-300">
            {count === null ? "…" : <><span className="font-semibold">{count}</span> recipient{count === 1 ? "" : "s"}</>}
          </span>
        </div>

        {audience === "recent" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Joined in the last</span>
            <input
              type="number" min={1} max={3650} value={recentDays}
              onChange={(e) => setRecentDays(Math.max(1, Number(e.target.value) || 1))}
              className={`${input} w-24`}
            />
            <span className="text-xs text-gray-500">days</span>
          </div>
        )}

        {audience === "custom" && (
          <RecipientPicker token={token} value={picked} onChange={setPicked} />
        )}

        {sample.length > 0 && (
          <p className="text-[11px] text-gray-400">
            e.g. {sample.join(", ")}
            {count && count > sample.length ? ` and ${count - sample.length} more` : ""}
          </p>
        )}
      </div>

      {note && (
        <div
          className={`px-3 py-2 rounded-lg text-xs border ${
            note.kind === "ok"
              ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400"
              : "border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400"
          }`}
        >
          {note.text}
        </div>
      )}

      {/* ── Send ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
          placeholder="you@example.com"
          className={`${input} w-56`}
        />
        <button
          onClick={() => testTo.trim() ? setPreview("test") : setNote({ kind: "err", text: "Enter an address to send the test to." })}
          disabled={!!busy}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
        >
          {busy === "test" && <Spinner className="w-4 h-4" />} Preview &amp; send test
        </button>
        <button
          onClick={() => setPreview("send")}
          disabled={!!busy || !count}
          className="ml-auto inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium transition-colors"
        >
          {busy === "send" && <Spinner className="w-4 h-4" />}
          Preview &amp; send to {count ?? 0}
        </button>
      </div>

      {/* ── History ───────────────────────────────────────────────────── */}
      {campaigns.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Subject</th>
                <th className="text-left px-4 py-2 font-medium">Audience</th>
                <th className="text-left px-4 py-2 font-medium">Progress</th>
                <th className="text-left px-4 py-2 font-medium">Sent</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2 truncate max-w-[18rem]">{c.subject}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs">{c.audience}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ${STATUS_STYLE[c.status] ?? STATUS_STYLE.queued}`}>
                      {c.status}
                    </span>
                    {c.status === "sending" && (
                      <span className="ml-2 text-xs text-gray-400 tabular-nums">
                        {c.sent}/{c.total}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 tabular-nums">
                    {c.sent}
                    {c.failed > 0 && <span className="text-red-500"> · {c.failed} failed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <SendPreview
          token={token}
          subject={subject}
          html={html}
          audience={audience}
          recentDays={recentDays}
          emails={emails}
          previewEmail={preview === "test" ? testTo.trim() : undefined}
          mode={preview}
          onClose={() => setPreview(null)}
          onConfirm={preview === "test" ? handleTest : handleSend}
        />
      )}

    </div>
  );
}
