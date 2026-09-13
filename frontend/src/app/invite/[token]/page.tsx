"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import MarkdropLoader from "@/components/MarkdropLoader";
import {
  acceptInvite, declineInvite, previewInvite, type InvitePreview,
} from "@/lib/workspaces";

const ROLE_BLURB: Record<string, string> = {
  admin: "manage members, domains and branding",
  member: "create and publish documents",
  viewer: "read what the workspace publishes",
  owner: "do anything in the workspace",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-[70vh] grid place-items-center px-4 py-10">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/50 backdrop-blur-sm p-7 text-center">
      {children}
    </div>
  );
}

function Glyph({ tone, children }: { tone: "blue" | "green" | "amber" | "gray"; children: React.ReactNode }) {
  const tones = {
    blue: "bg-blue-500/10 text-blue-500",
    green: "bg-emerald-500/10 text-emerald-500",
    amber: "bg-amber-500/10 text-amber-500",
    gray: "bg-gray-500/10 text-gray-400",
  };
  return (
    <span className={`w-12 h-12 rounded-2xl grid place-items-center mx-auto mb-4 ${tones[tone]}`}>
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </span>
  );
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [actionError, setActionError] = useState("");
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);
  const [joined, setJoined] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setInvite(await previewInvite(token));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "This invitation link isn't valid.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Waits for auth to settle before asking: the preview tells us whether the
  // signed-in address matches, and asking too early would always say "no".
  useEffect(() => {
    if (authLoading) return;
    load();
  }, [authLoading, load]);

  if (authLoading || loading) {
    return (
      <Shell>
        <MarkdropLoader label="Checking invitation…" />
      </Shell>
    );
  }

  if (loadError || !invite) {
    return (
      <Shell>
        <Panel>
          <Glyph tone="gray"><><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></></Glyph>
          <h1 className="text-lg font-semibold mb-1.5">This link doesn&apos;t work</h1>
          <p className="text-sm text-gray-500 leading-relaxed">{loadError}</p>
          <a href="/" className="inline-block mt-5 text-sm text-blue-500 hover:underline">Go to Markdrop</a>
        </Panel>
      </Shell>
    );
  }

  // ── Terminal states ────────────────────────────────────────────────────────

  if (done === "accepted" && joined) {
    return (
      <Shell>
        <Panel>
          <Glyph tone="green"><path d="M20 6 9 17l-5-5" /></Glyph>
          <h1 className="text-lg font-semibold mb-1.5">You&apos;re in</h1>
          <p className="text-sm text-gray-500 leading-relaxed">
            You joined <strong className="text-gray-700 dark:text-gray-300">{joined.name}</strong> as a {invite.role}.
          </p>
          <button
            onClick={() => router.push(`/settings/workspaces/${joined.id}`)}
            className="mt-5 w-full px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
          >
            Open workspace
          </button>
        </Panel>
      </Shell>
    );
  }

  if (done === "declined") {
    return (
      <Shell>
        <Panel>
          <Glyph tone="gray"><path d="M18 6 6 18M6 6l12 12" /></Glyph>
          <h1 className="text-lg font-semibold mb-1.5">Invitation declined</h1>
          <p className="text-sm text-gray-500 leading-relaxed">
            You haven&apos;t been added to {invite.workspace_name}, and nothing was shared with you.
          </p>
          <a href="/" className="inline-block mt-5 text-sm text-blue-500 hover:underline">Go to Markdrop</a>
        </Panel>
      </Shell>
    );
  }

  if (invite.status !== "pending") {
    const copy: Record<string, { title: string; body: string }> = {
      accepted: { title: "Already accepted", body: "This invitation has already been used." },
      declined: { title: "Already declined", body: "This invitation was declined. Ask for a new one if that was a mistake." },
      revoked: { title: "Invitation withdrawn", body: "An admin cancelled this invitation." },
      expired: { title: "Invitation expired", body: "Invitations are valid for 7 days. Ask whoever invited you to send a new one." },
    };
    const c = copy[invite.status] ?? { title: "Nothing to do here", body: "This invitation is no longer open." };
    return (
      <Shell>
        <Panel>
          <Glyph tone="amber"><><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></></Glyph>
          <h1 className="text-lg font-semibold mb-1.5">{c.title}</h1>
          <p className="text-sm text-gray-500 leading-relaxed">{c.body}</p>
          <p className="text-xs text-gray-400 mt-3">{invite.workspace_name}</p>
          <a href="/" className="inline-block mt-5 text-sm text-blue-500 hover:underline">Go to Markdrop</a>
        </Panel>
      </Shell>
    );
  }

  // ── The live invitation ────────────────────────────────────────────────────

  const header = (
    <>
      <Glyph tone="blue">
        <><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M20 8v6M23 11h-6" /></>
      </Glyph>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Workspace invitation</p>
      <h1 className="text-xl font-bold leading-snug mb-2">
        {invite.invited_by_name ? `${invite.invited_by_name} invited you to` : "You've been invited to"}{" "}
        <span className="text-blue-500">{invite.workspace_name}</span>
      </h1>
      <p className="text-sm text-gray-500 leading-relaxed">
        As a <strong className="text-gray-700 dark:text-gray-300">{invite.role}</strong>, you&apos;ll be able to{" "}
        {ROLE_BLURB[invite.role] ?? "collaborate"}.
      </p>
    </>
  );

  // Already a member — accepting would be a no-op, so don't offer it.
  if (invite.already_member) {
    return (
      <Shell>
        <Panel>
          <Glyph tone="green"><path d="M20 6 9 17l-5-5" /></Glyph>
          <h1 className="text-lg font-semibold mb-1.5">You&apos;re already in {invite.workspace_name}</h1>
          <p className="text-sm text-gray-500 leading-relaxed">Nothing to accept — you already have access.</p>
          <a href="/settings/workspaces" className="inline-block mt-5 text-sm text-blue-500 hover:underline">
            Open workspaces
          </a>
        </Panel>
      </Shell>
    );
  }

  // Not signed in. Sending them through login with `next` set brings them back
  // here afterwards, so the invitation survives the detour — including for
  // someone who has to create an account on the way.
  if (!user) {
    return (
      <Shell>
        <Panel>
          {header}
          <div className="mt-5 rounded-lg bg-gray-50 dark:bg-gray-900/60 px-3 py-2.5 text-xs text-gray-500">
            Sign in as <strong className="text-gray-700 dark:text-gray-300">{invite.email}</strong> to accept.
            Don&apos;t have an account? You can create one with that address.
          </div>
          <button
            onClick={() => router.push(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}
            className="mt-4 w-full px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
          >
            Sign in to continue
          </button>
          <button
            onClick={async () => {
              setBusy("decline"); setActionError("");
              try { await declineInvite(token); setDone("declined"); }
              catch (e) { setActionError(e instanceof Error ? e.message : "Something went wrong"); }
              finally { setBusy(null); }
            }}
            disabled={busy !== null}
            className="mt-2 w-full px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
          >
            {busy === "decline" ? "Declining…" : "Decline"}
          </button>
          {actionError && <p className="text-xs text-red-500 mt-3">{actionError}</p>}
        </Panel>
      </Shell>
    );
  }

  // Signed in as the wrong person. Naming both addresses is the difference
  // between a dead end and an obvious fix — and the token holder was already
  // told the invited address by the email that carried this link.
  if (!invite.email_matches) {
    return (
      <Shell>
        <Panel>
          {header}
          <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-left text-amber-700 dark:text-amber-400">
            This invitation was sent to <strong>{invite.email}</strong>, but you&apos;re signed in as{" "}
            <strong>{invite.signed_in_as}</strong>. Switch accounts to accept it.
          </div>
          <button
            onClick={() => router.push(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}
            className="mt-4 w-full px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
          >
            Sign in as {invite.email}
          </button>
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell>
      <Panel>
        {header}
        <div className="mt-5 rounded-lg bg-gray-50 dark:bg-gray-900/60 px-3 py-2.5 text-xs text-gray-500">
          Accepting as <strong className="text-gray-700 dark:text-gray-300">{invite.signed_in_as}</strong>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            onClick={async () => {
              setBusy("accept"); setActionError("");
              try {
                const r = await acceptInvite(token);
                setJoined({ id: r.workspace_id, name: r.workspace_name });
                setDone("accepted");
              } catch (e) {
                setActionError(e instanceof Error ? e.message : "Something went wrong");
                load();  // the reason is usually a state change — show the new one
              } finally { setBusy(null); }
            }}
            disabled={busy !== null}
            className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {busy === "accept" ? "Joining…" : "Accept invitation"}
          </button>
          <button
            onClick={async () => {
              setBusy("decline"); setActionError("");
              try { await declineInvite(token); setDone("declined"); }
              catch (e) { setActionError(e instanceof Error ? e.message : "Something went wrong"); }
              finally { setBusy(null); }
            }}
            disabled={busy !== null}
            className="px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 text-sm transition-colors"
          >
            {busy === "decline" ? "…" : "Decline"}
          </button>
        </div>
        {actionError && <p className="text-xs text-red-500 mt-3">{actionError}</p>}
      </Panel>
    </Shell>
  );
}
