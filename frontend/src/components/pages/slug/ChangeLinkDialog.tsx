"use client";

/**
 * Page ⋯ › "Change link…": a page's slug, which is the last part of its address on markdrop.in and
 * on its workspace's own domain (`/<folders>/<parent pages>/<slug>`).
 *
 *   - the current link, and an input for the new slug with the rest of the address as its prefix;
 *   - live validation (slugRules.mjs: 3-50 letters, digits, - or _, not one of Markdrop's routes),
 *     then the API's verdict as you type (`GET …/slug-check`, 350 ms after the last key: taken,
 *     reserved, a folder beside it) with the full new link as it will be;
 *   - a note that the old link keeps working (it redirects, and so do embeds and mentions of it);
 *   - Change link renames (`PATCH …/slug`), purges both renders and opens the page at its new link.
 *
 * Offered to whoever may rename it (its owner, or the edit secret's holder): the API decides.
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, Field, Icon, Input, Spinner, useToast } from "@/components/ui";
import { cleanSlugInput, shortBase, slugProblem, splitLink } from "./slugRules.mjs";
import { SlugApiError, checkSlug, renameSlug, type SlugCheck } from "./slugApi";

type Verdict =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; check: SlugCheck }
  | { state: "bad"; check: SlugCheck }
  | { state: "error"; message: string };

const DEBOUNCE_MS = 350;

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function ChangeLinkDialog({ slug, secret = null, onClose, onChanged }: {
  slug: string;
  /** The edit secret, when that is how this person may rename it. */
  secret?: string | null;
  onClose: () => void;
  /** After the rename. Default: open the page at its new link (the old one redirects there). */
  onChanged?: (newSlug: string, url: string) => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState<SlugCheck | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState(slug);
  const [verdict, setVerdict] = useState<Verdict>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The current link, the address around the slug and the old links that already redirect here.
  useEffect(() => {
    const ac = new AbortController();
    checkSlug(slug, slug, { secret, signal: ac.signal })
      .then(setCurrent)
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setLoadError(e instanceof SlugApiError && (e.status === 403 || e.status === 401)
          ? "Only the page's owner can change its link."
          : errText(e, "Couldn't load this page's link."));
      });
    return () => ac.abort();
  }, [slug, secret]);

  const trimmed = value.trim();
  const local = trimmed === slug ? null : slugProblem(trimmed);
  const unchanged = trimmed === slug;

  // Ask the API, 350 ms after the last change.
  useEffect(() => {
    if (unchanged || local) {
      setVerdict({ state: "idle" });
      return;
    }
    setVerdict({ state: "checking" });
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      checkSlug(slug, trimmed, { secret, signal: ac.signal })
        .then((check) => {
          if (check.slug !== trimmed) return;
          setVerdict(check.available ? { state: "ok", check } : { state: "bad", check });
        })
        .catch((e) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setVerdict({ state: "error", message: errText(e, "Couldn't check that link. Try again.") });
        });
    }, DEBOUNCE_MS);
    return () => {
      ac.abort();
      window.clearTimeout(t);
    };
  }, [trimmed, unchanged, local, slug, secret]);

  const ready = verdict.state === "ok" && verdict.check.slug === trimmed && !busy;
  const where = splitLink(current?.url ?? "");
  const previewUrl = verdict.state === "ok" || verdict.state === "bad" ? verdict.check.url
    : current ? current.url.replace(/[^/]*$/, encodeURIComponent(trimmed)) : null;
  const filed = !!current?.workspace_url;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || verdict.state !== "ok") return;
    setBusy(true);
    setSaveError(null);
    try {
      const now = await renameSlug(slug, trimmed, secret);
      const url = verdict.check.url;
      toast.success("Link changed. The old link now redirects here.");
      if (onChanged) onChanged(now, url);
      // A full load at the new address: the editor, its lock and the live socket all key on the slug.
      else window.location.replace(`/${encodeURIComponent(now)}${window.location.search}${window.location.hash}`);
    } catch (err) {
      setSaveError(errText(err, "Couldn't change the link. Check your connection and try again."));
      setBusy(false);
    }
  }

  const status = (() => {
    if (unchanged) return null;
    if (local) return null;
    if (verdict.state === "checking") return <span className="inline-flex items-center gap-1.5" data-state="checking" data-testid="change-link-status"><Spinner size={12} /> Checking…</span>;
    if (verdict.state === "ok") return <span className="inline-flex items-center gap-1.5 text-success" data-state="ok" data-testid="change-link-status"><Icon name="checkCircle" /> Available</span>;
    return null;
  })();
  const fieldError = local
    ?? (verdict.state === "bad" ? verdict.check.detail || "That link can't be used." : null)
    ?? (verdict.state === "error" ? verdict.message : null);

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Change link"
      description="The address people use to open this page."
      initialFocus={inputRef}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="md-change-link" loading={busy} disabled={!ready} data-testid="change-link-submit">
            Change link
          </Button>
        </>
      }
    >
      <form id="md-change-link" onSubmit={submit} className="flex flex-col gap-3" data-testid="change-link-dialog">
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        <div className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">Current link</span>
          <span className="ph-sensitive break-all font-mono text-body text-text" data-testid="change-link-current">
            {current ? current.url.replace(/^https?:\/\//, "") : "…"}
          </span>
        </div>
        <Field label="New link" error={fieldError ?? undefined} hint={status ?? undefined}>
          <Input
            ref={inputRef}
            mono
            textPrefix={current ? shortBase(where.base) : undefined}
            value={value}
            maxLength={60}
            autoComplete="off"
            spellCheck={false}
            aria-label="New link"
            data-testid="change-link-input"
            disabled={busy || !!loadError}
            onChange={(e) => { setValue(cleanSlugInput(e.target.value)); setSaveError(null); }}
          />
        </Field>
        {previewUrl && !unchanged && !local && (
          <div className="flex flex-col gap-1" data-testid="change-link-preview">
            <span className="text-caption text-text-secondary">New address</span>
            <span className="break-all font-mono text-body text-text">{previewUrl.replace(/^https?:\/\//, "")}</span>
            {filed && verdict.state === "ok" && (
              <span className="break-all font-mono text-caption text-text-secondary">also {verdict.check.markdrop_url.replace(/^https?:\/\//, "")}</span>
            )}
          </div>
        )}
        <Alert tone="info" icon="arrowRight">
          The old link keeps working: it redirects here{filed ? ` on ${where.host} and on markdrop.in` : ""}, sub-page links included. Embeds and mentions of this page keep working too.
          {current && current.redirects_from.length > 0 && (
            <> Older links that already redirect here: <span className="font-mono">{current.redirects_from.join(", ")}</span>.</>
          )}
        </Alert>
        {saveError && <Alert tone="danger">{saveError}</Alert>}
      </form>
    </Dialog>
  );
}

export default ChangeLinkDialog;
