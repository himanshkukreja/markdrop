"use client";

import { useEffect, useId, useState } from "react";
import { Alert, Button, Icon, Input } from "@/components/ui";
import { accentTokens } from "@/components/tenant/branding";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** The native colour input needs *some* value; this is user data (Markdrop's own blue), not UI colour. */
const FALLBACK = "#3b82f6";

/**
 * Accent colour: the OS colour picker, and a hex field.
 *
 * There was a grid of preset swatches here too. It was removed deliberately —
 * anyone setting a workspace accent is matching a brand they already have, so
 * they arrive with a hex code rather than a wish to browse.
 *
 * The typed hex is held in local state while it is being edited and only pushed
 * up once it parses. Without that, typing "#1" over a selection would commit an
 * invalid colour on the first keystroke and the server would reject the save.
 *
 * The contrast check uses the same maths the tenant chrome uses (components/tenant/branding):
 * when white text doesn't reach 4.5:1 on the colour, buttons on the workspace's domain get dark
 * text, and we say so here rather than let it be a surprise.
 */
export default function ColorPicker({
  value,
  disabled,
  locked,
  onChange,
  label = "Accent colour",
}: {
  value: string | null;
  disabled?: boolean;
  /** Non-admins: readable and focusable, but inert. */
  locked?: boolean;
  onChange: (hex: string | null) => void;
  label?: string;
}) {
  const uid = useId();
  const [draft, setDraft] = useState(value ?? "");

  // Re-sync when the value changes from outside (Discard, or a reload).
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const off = disabled || locked;
  const current = value && HEX.test(value) ? value : FALLBACK;
  const invalid = draft.trim() !== "" && !HEX.test(draft.trim());
  const tokens = value && HEX.test(value) ? accentTokens(value) : null;
  const darkText = !!tokens && tokens.onAccent.toLowerCase() !== "#ffffff";

  return (
    <div className="md-field min-w-0">
      <div className="flex items-center justify-between gap-2">
        <label className="md-field__label" htmlFor={`${uid}-hex`}>{label}</label>
        {value && !off && (
          <Button variant="link" size="sm" onClick={() => onChange(null)} aria-label="Reset accent colour to Markdrop's default">
            Reset
          </Button>
        )}
      </div>

      <div className="md-color min-w-0">
        <span className="md-color__swatch" style={{ background: current }} title={off ? undefined : "Pick a colour"}>
          <input
            type="color"
            value={current}
            disabled={disabled}
            aria-disabled={locked || undefined}
            onChange={(e) => !off && onChange(e.target.value)}
            onClick={locked ? (e) => e.preventDefault() : undefined}
            aria-label="Pick a colour"
            style={{ opacity: 0 }}
          />
        </span>
        <Input
          id={`${uid}-hex`}
          mono
          value={draft}
          disabled={disabled}
          readOnly={locked}
          aria-disabled={locked || undefined}
          placeholder={FALLBACK}
          spellCheck={false}
          invalid={invalid}
          aria-describedby={invalid ? `${uid}-err` : `${uid}-hint`}
          wrapClassName="min-w-0 flex-1"
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            const trimmed = next.trim();
            if (trimmed === "") onChange(null);
            else if (HEX.test(trimmed)) onChange(trimmed);
          }}
        />
      </div>
      {invalid ? (
        <div id={`${uid}-err`} className="md-field__error" role="alert">
          <Icon name="alertCircle" /> Use a hex colour like #0f766e.
        </div>
      ) : (
        <div id={`${uid}-hint`} className="md-field__hint">Buttons, links and highlights on your domain use it. Blank uses Markdrop&apos;s blue.</div>
      )}
      {darkText && (
        <Alert tone="warning" className="mt-2">
          White text on this colour is hard to read. Buttons on your domain will use dark text instead.
        </Alert>
      )}
    </div>
  );
}
