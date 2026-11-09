"use client";

/**
 * The sign-off card, the same for readers (PageRenderer) and the editor (SignoffView): the label,
 * the person who signs with their avatar, and, for that person only, the options as buttons. Once
 * signed: who, when and the decision in its colour, and a note that the section above is locked.
 *
 * Everything about the decision comes from the server (`state`); the Markdown only says who signs,
 * what the options are and whether it locks the section above (`info`).
 */
import { useState, type ReactNode } from "react";
import { Avatar, Icon } from "@/components/ui";
import { PagesApiError } from "@/lib/pages";
import type { SignoffInfo } from "@/lib/signoff.mjs";
import { tone as toneOf } from "@/lib/signoff.mjs";
import type { SignoffState } from "@/lib/signoffs";
import type { PersonCard } from "./store";
import "./signoff.css";

export interface SignoffCardProps {
  info: SignoffInfo;
  state?: SignoffState;
  /** The person's name and picture when the server hasn't said (just picked in the editor). */
  person?: PersonCard;
  /** The state is still loading (the buttons wait). */
  loading?: boolean;
  /** The viewer's decision (`null` clears it). Without it, nobody can choose here. */
  /** ``acknowledgeOpenComments``: the person confirmed signing while comment threads are still open. */
  onSign?: (option: string | null, acknowledgeOpenComments?: boolean) => Promise<void>;
  /** Editor: the label as an input instead of text. */
  labelSlot?: ReactNode;
  /** Editor: the person picker instead of "Waiting for …". */
  personSlot?: ReactNode;
  /** Editor: the options and lock settings (unsigned blocks). */
  settings?: ReactNode;
  /** Editor: extra actions in the head (an admin's "Remove"). */
  actions?: ReactNode;
  /** The block's text. */
  children?: ReactNode;
  className?: string;
  /** In the editor: everything but the text is outside the editable content. */
  inEditor?: boolean;
}

const fmt = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "numeric", minute: "2-digit" });
};

const TONE_ICON: Record<string, string> = { success: "checkCircle", danger: "alertCircle", warning: "alert", neutral: "checkCircle" };

export function SignoffCard({ info, state, person, loading, onSign, labelSlot, personSlot, settings, actions, children, className, inEditor }: SignoffCardProps) {
  const ce = inEditor ? ({ contentEditable: false, suppressContentEditableWarning: true } as const) : {};
  const [busy, setBusy] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const option = state?.option ?? null;
  const signed = !!option;
  const tone = signed ? state?.tone ?? toneOf(option, info.options) ?? "neutral" : null;
  const canSign = !!state?.can_sign && !!onSign;
  const who = state?.person?.name || person?.name || null;
  const avatar = state?.person?.avatar || person?.avatar || undefined;
  const signer = state?.signed_by?.name || who;
  const options = state?.options?.length ? state.options : info.options;

  // The sign-off guard: comment threads still open on the page are named first (the server checks too).
  const [confirm, setConfirm] = useState<{ option: string; open: number } | null>(null);
  const openNow = state?.comments?.open_now ?? 0;

  async function choose(o: string | null, ack = false) {
    if (!onSign) return;
    if (o !== null && !ack && openNow > 0) {
      setConfirm({ option: o, open: openNow });
      return;
    }
    setBusy(o ?? "__clear");
    setError(null);
    try {
      await onSign(o, ack);
      setChanging(false);
      setConfirm(null);
    } catch (e) {
      if (o !== null && e instanceof PagesApiError && e.info?.code === "open_comments") {
        setConfirm({ option: o, open: Number(e.info.open) || 1 });
      } else {
        setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.");
      }
    } finally {
      setBusy(null);
    }
  }
  const record = signed ? state?.comments?.record : null;

  const buttons = (
    <div className="pb-signoff__options" role="group" aria-label={`Sign off: ${info.label}`}>
      {options.map((o, i) => {
        const t = toneOf(o, options);
        const current = o === option;
        return (
          <button
            key={o}
            type="button"
            className={`pb-signoff__opt pb-signoff__opt--${i === 0 && t === "success" ? "primary" : t ?? "neutral"}${current ? " is-current" : ""}`}
            disabled={!!busy || loading || current}
            aria-pressed={current}
            onClick={() => void choose(o)}
          >
            {busy === o ? <span className="pb-signoff__spin" aria-hidden /> : t === "success" ? <Icon name="check" size={14} aria-hidden /> : t === "danger" ? <Icon name="x" size={14} aria-hidden /> : null}
            <span>{o}</span>
          </button>
        );
      })}
      {signed && (
        <button type="button" className="pb-signoff__link" disabled={!!busy} onClick={() => void choose(null)}>
          {busy === "__clear" ? "Clearing…" : "Clear my decision"}
        </button>
      )}
      {signed && changing && (
        <button type="button" className="pb-signoff__link" disabled={!!busy} onClick={() => setChanging(false)}>
          Cancel
        </button>
      )}
    </div>
  );

  return (
    <div
      className={["pb-signoff", "not-prose", signed ? `pb-signoff--signed pb-signoff--${tone}` : "pb-signoff--waiting", className].filter(Boolean).join(" ")}
      data-signoff={info.id ?? undefined}
    >
      <div className="pb-signoff__head" {...ce}>
        <span className="pb-signoff__badge" aria-hidden>
          <Icon name={signed ? TONE_ICON[tone ?? "neutral"] : "flag"} size={16} />
        </span>
        <div className="pb-signoff__titles">
          <span className="pb-signoff__eyebrow">Sign-off</span>
          {labelSlot ?? <span className="pb-signoff__label">{info.label}</span>}
        </div>
        <span className={`pb-signoff__status${signed ? ` pb-signoff__status--${tone}` : ""}`}>
          {signed ? (
            <>
              <Icon name={tone === "danger" ? "x" : "check"} size={12} aria-hidden />
              <span>{option}</span>
            </>
          ) : (
            <>
              <Icon name="clock" size={12} aria-hidden />
              <span>{info.person ? "Waiting" : "No one asked yet"}</span>
            </>
          )}
        </span>
        {actions}
      </div>

      {children != null && <div className="pb-signoff__body">{children}</div>}

      {settings}

      <div className="pb-signoff__foot" {...ce}>
        {personSlot ?? (
          <div className="pb-signoff__who">
            {info.person && (canSign || (signed ? signer : who)) ? (
              <Avatar name={(signed ? signer : who) || "You"} src={(signed ? state?.signed_by?.avatar || avatar : avatar) || undefined} size="sm" />
            ) : (
              <span className="pb-signoff__nobody" aria-hidden><Icon name="user" size={14} /></span>
            )}
            <span className="pb-signoff__who-text">
              {!info.person ? (
                "Nobody is named to sign this yet."
              ) : signed ? (
                <>
                  {canSign || signer ? <><strong className="ph-mask">{canSign ? "You" : signer}</strong> signed off</> : "Signed off"}
                  {state?.signed_at && <> · <time dateTime={state.signed_at}>{fmt(state.signed_at)}</time></>}
                </>
              ) : canSign ? (
                <>
                  <strong>You</strong> are asked to sign this off
                </>
              ) : (
                <>
                  Waiting for <strong className="ph-mask">{who || "a person"}</strong>
                </>
              )}
            </span>
          </div>
        )}
        {canSign && !signed && buttons}
        {canSign && signed && !changing && (
          <div className="pb-signoff__options">
            <button type="button" className="pb-signoff__link" onClick={() => setChanging(true)}>
              Change decision
            </button>
          </div>
        )}
      </div>
      {canSign && signed && changing && <div className="pb-signoff__change" {...ce}>{buttons}</div>}

      {confirm && (
        <div className="pb-signoff__confirm" role="alertdialog" aria-label="Open comments" {...ce}>
          <Icon name="message" size={14} aria-hidden />
          <span>
            {confirm.open} comment thread{confirm.open === 1 ? " is" : "s are"} still open on this page.
          </span>
          <button type="button" className="pb-signoff__link" disabled={!!busy} onClick={() => void choose(confirm.option, true)}>
            {busy ? "Signing…" : `Sign off anyway: ${confirm.option}`}
          </button>
          <button type="button" className="pb-signoff__link" disabled={!!busy} onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      {record && (record.resolved > 0 || record.open > 0) && (
        <p className="pb-signoff__comments" {...ce}>
          <Icon name="message" size={12} aria-hidden />
          <span>
            Signed with {record.resolved} comment thread{record.resolved === 1 ? "" : "s"} resolved
            {record.open > 0 ? ` and ${record.open} still open` : ""}.
          </span>
        </p>
      )}
      {error && (
        <p className="pb-signoff__error" role="alert" {...ce}>
          <Icon name="alertCircle" size={14} aria-hidden /> {error}
        </p>
      )}
      {signed && info.lock && (
        <div className="pb-signoff__lock" {...ce}>
          <Icon name="lock" size={12} aria-hidden />
          <span>The section above is locked while this is signed off.</span>
        </div>
      )}
    </div>
  );
}
