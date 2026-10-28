"use client";

/**
 * The owner's side of "No dead ends" (RequestAccess board): /requests/<id>, where the email's
 * "Let them view / Let them edit / Decline" buttons land (`?action=view|edit|decline`).
 *
 * The email's choice is pre-selected but never acted on by just opening the link: mail scanners
 * follow links, so a decision always takes a press here, signed in as the document's owner. The
 * server decides who may decide (owner only) and the call is idempotent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Avatar, Badge, Button, EmptyState, Icon, Skeleton } from "@/components/ui";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { relativeTime } from "@/components/dashboard/format";
import { useAuth } from "@/contexts/AuthContext";
import {
  decideAccessRequest, getAccessRequest, requestTitle, requesterName, type AccessRequest, type RequestDecision,
} from "@/lib/me";
import { errorStatus } from "@/lib/workspaces";

const LABEL: Record<RequestDecision, string> = { view: "Let them view", edit: "Let them edit", decline: "Decline" };

export default function RequestReview({ id }: { id: string }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const mounted = useMounted();
  const search = useLocationSearch();
  const action = useMemo(() => {
    const a = new URLSearchParams(search).get("action");
    return a === "view" || a === "edit" || a === "decline" ? (a as RequestDecision) : null;
  }, [search]);

  useEffect(() => {
    if (authLoading || !mounted || user) return;
    router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [authLoading, mounted, user, router]);

  const [req, setReq] = useState<AccessRequest | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<RequestDecision | null>(null);
  const [done, setDone] = useState<RequestDecision | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const chosenRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!user) return;
    let live = true;
    getAccessRequest(id)
      .then((r) => { if (live) setReq(r); })
      .catch((e) => {
        if (!live) return;
        setReq(null);
        // 404 is the answer for "not yours" too: never say whether it exists.
        const s = errorStatus(e);
        if (s !== 404) setError(e instanceof Error && e.message ? e.message : "Couldn't load the request.");
      });
    return () => { live = false; };
  }, [user, id]);

  // The email's choice: focus it, so one press (or Enter) confirms.
  useEffect(() => {
    if (req && req.status === "pending" && action) chosenRef.current?.focus();
  }, [req, action]);

  useEffect(() => {
    if (done) resultRef.current?.focus();
  }, [done]);

  async function decide(d: RequestDecision) {
    if (!req || busy) return;
    setBusy(d);
    setError("");
    try {
      const r = await decideAccessRequest(req.id, d);
      setReq({ ...req, status: r.status, role_granted: r.role_granted, decided_at: r.decided_at });
      setDone(d);
    } catch (e) {
      const s = errorStatus(e);
      setError(
        s === 409 ? "This request was already answered another way. Reload to see what was decided."
          : s === 404 ? "Only the file's owner can answer this request."
            : e instanceof Error && e.message ? e.message : "That didn't go through. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  if (authLoading || !user || req === undefined) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <span className="md-visually-hidden">Loading the request</span>
        <Skeleton width={220} height={30} />
        <Skeleton variant="rect" height={220} />
      </div>
    );
  }

  if (!req) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="md-visually-hidden">Access request</h1>
        {error && <Alert tone="danger">{error}</Alert>}
        <EmptyState
          icon="inbox"
          title="This request isn't here"
          description="It may be for a file you don't own, or it was answered already. Requests for your files show in Shared with me."
          actions={<Button variant="secondary" href="/shared">Go to Shared with me</Button>}
        />
      </div>
    );
  }

  const who = requesterName(req);
  const first = (req.requester.name || req.requester.email.split("@")[0] || "them").split(/\s+/)[0];
  const title = requestTitle(req);
  const decided = req.status !== "pending";
  const outcome = req.status === "declined"
    ? `Declined. We've let ${first} know.`
    : `${first} can ${req.role_granted === "editor" ? "edit" : "view"} “${title}” now. We've emailed them.`;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <p className="text-eyebrow uppercase text-text-muted">Access request</p>
        <h1 className="mt-1 text-h2 text-text [overflow-wrap:anywhere]" dir="auto">{who} asked to open “{title}”</h1>
      </div>

      <section aria-label="The request" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={who} size="lg" />
          <div className="min-w-0">
            <div className="truncate text-body-strong text-text" dir="auto">{who}</div>
            <div className="text-caption text-text-muted">
              {[req.requester.name ? req.requester.email : null, relativeTime(req.created_at)].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>
        {req.message ? (
          <blockquote className="m-0 rounded-lg bg-surface-inset px-3.5 py-2.5 text-body text-text-secondary [overflow-wrap:anywhere]" dir="auto">{req.message}</blockquote>
        ) : (
          <p className="text-caption text-text-muted">No message.</p>
        )}

        {decided ? (
          <div ref={resultRef} tabIndex={-1} role="status" className="flex flex-col gap-3 outline-none">
            <p className="flex items-start gap-2 text-body text-text">
              <Icon name={req.status === "declined" ? "x" : "checkCircle"} size={18} className={req.status === "declined" ? "mt-0.5 text-text-muted" : "mt-0.5 text-success"} />
              <span>
                {done ? outcome : req.status === "declined" ? `You declined this ${req.decided_at ? relativeTime(req.decided_at) : ""}.` : `You let ${first} ${req.role_granted === "editor" ? "edit" : "view"} it ${req.decided_at ? relativeTime(req.decided_at) : ""}.`}
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" href={`/${encodeURIComponent(req.document.slug)}`} iconLeft="external">Open “{title}”</Button>
              <Button variant="ghost" href="/shared">Other requests</Button>
            </div>
          </div>
        ) : (
          <>
            {action && (
              <p className="text-caption text-text-secondary">
                From your email: <Badge size="sm">{LABEL[action]}</Badge> Press it to confirm.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button ref={action === "view" ? chosenRef : undefined} variant={action && action !== "view" ? "secondary" : "primary"} iconLeft="eye" loading={busy === "view"} disabled={!!busy && busy !== "view"} onClick={() => void decide("view")}>Let them view</Button>
              <Button ref={action === "edit" ? chosenRef : undefined} variant={action === "edit" ? "primary" : "secondary"} iconLeft="edit" loading={busy === "edit"} disabled={!!busy && busy !== "edit"} onClick={() => void decide("edit")}>Let them edit</Button>
              <Button ref={action === "decline" ? chosenRef : undefined} variant={action === "decline" ? "secondary" : "ghost"} loading={busy === "decline"} disabled={!!busy && busy !== "decline"} onClick={() => void decide("decline")}>Decline</Button>
            </div>
            <p className="text-caption text-text-muted">
              This shares only this item with {first}. It doesn&apos;t add them to a workspace.
            </p>
          </>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </section>
    </div>
  );
}
