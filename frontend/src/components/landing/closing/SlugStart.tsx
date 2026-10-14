"use client";

import { useId, useState, type FormEvent } from "react";
import { slugifyFilename } from "@/lib/slugify";
import { Icon } from "../orbit/ds";
import s from "./Closing.module.css";

/** /new accepts custom slugs of 3–50 characters (backend DocumentCreate.custom_slug). */
const MIN = 3;

/**
 * The closing CTA's slug field: markdrop.in/ + a mono input, then "Start writing" → /new?slug=<value>.
 * Cleaned with the lib/slugify rules (lowercase letters, digits and dashes) when it is submitted; the
 * value never leaves the browser except as that query parameter, and is never tracked. Without JS it
 * is a plain GET form to /new.
 */
export default function SlugStart() {
  const id = useId();
  const [raw, setRaw] = useState("team-offsite");
  const clean = slugifyFilename(raw);
  const bad = raw.trim() !== "" && clean.length < MIN;
  const [tried, setTried] = useState(false);
  const showErr = bad && tried;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (bad) {
      setTried(true);
      return;
    }
    window.location.assign(clean ? "/new?slug=" + encodeURIComponent(clean) : "/new");
  };

  const hint = !showErr && clean && clean !== raw.trim() ? "Becomes markdrop.in/" + clean : "";

  return (
    <form action="/new" method="get" className={s.form} onSubmit={submit} noValidate>
      <div className={s.row}>
        <label htmlFor={id} className={s.field} data-bad={showErr ? "" : undefined}>
          <span className={s.prefix} aria-hidden="true">
            markdrop.in/
          </span>
          <span className={s.sr}>Choose the end of your link: markdrop.in/</span>
          <input
            id={id}
            name="slug"
            className={s.input}
            type="text"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setTried(false);
            }}
            placeholder="your-link"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            maxLength={60}
            aria-invalid={showErr || undefined}
            aria-describedby={id + "-cap"}
          />
        </label>
        <button type="submit" className="md-btn md-btn--primary md-btn--lg" data-cta="close_start">
          Start writing
          <Icon name="arrowRight" />
        </button>
      </div>
      <p id={id + "-cap"} className={showErr ? s.err : s.cap} aria-live="polite">
        {showErr ? "Use at least 3 letters or numbers." : hint || "Nothing is reserved until you publish. No account needed."}
      </p>
    </form>
  );
}
