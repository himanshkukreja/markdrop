"use client";

import { useState } from "react";
import LoopVideo from "@/components/guides-landing/LoopVideo";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { track } from "@/lib/track";
import { Badge, Icon } from "../orbit/ds";
import s from "./Sections.module.css";
import t from "./theme.module.css";

type StampId = "people" | "password" | "expiry" | "e2e";

/** The stamps carry the Share dialog's own words (components/access/ShareDialog). */
const STAMPS: Array<{ id: StampId; short: string; label: string }> = [
  { id: "people", short: "People only", label: "Only people added" },
  { id: "password", short: "Password", label: "Password" },
  { id: "expiry", short: "Expires Fri", label: "Expires Friday" },
  { id: "e2e", short: "End-to-end", label: "End-to-end" },
];

const IMPRINT: Record<StampId, { text: string; style: React.CSSProperties }> = {
  people: { text: "People only", style: { right: 26, top: 64, "--r": "8deg" } as React.CSSProperties },
  password: { text: "Password", style: { right: 60, top: "34%", "--r": "-6deg" } as React.CSSProperties },
  expiry: { text: "Expires Friday", style: { left: 36, top: "52%", "--r": "-9deg" } as React.CSSProperties },
  e2e: { text: "End-to-end", style: { right: 34, top: "70%", "--r": "5deg" } as React.CSSProperties },
};

type Tone = "success" | "neutral" | "info" | "warning";
interface Row {
  name: string;
  initials: string;
  role: string;
  neutral?: boolean;
  status: [string, Tone, string];
}

/**
 * 3 · "Stamp it, then send it." Press a stamp onto the document (a real screenshot of the sample
 * rendered by Markdrop) and "Who gets in" follows, in the real Share dialog's words and states:
 * Only people added / Anyone with the link, a password that is only for people without access, an
 * expiry date, end-to-end encryption (documents only: the key stays in the link). Next to it, the real
 * Share dialog, recorded on the sandbox stack.
 */
export default function Stamps() {
  const [on, setOn] = useState<Record<StampId, boolean>>({ people: true, password: false, expiry: false, e2e: false });
  const [presses, setPresses] = useState<Record<StampId, number>>({ people: 0, password: 0, expiry: 0, e2e: 0 });

  const press = (id: StampId) => {
    const next = !on[id];
    setOn((o) => ({ ...o, [id]: next }));
    setPresses((p) => ({ ...p, [id]: p[id] + 1 }));
    track("landing_stamp", { stamp: id, on: next });
  };

  const notAdded: Row["status"] = on.people
    ? ["Can request access", "neutral", "userX"]
    : on.password
      ? ["Needs the password", "warning", "lock"]
      : ["Opens", "success", "check"];
  const rows: Row[] = [
    { name: "Dana Lee", initials: "DL", role: "Added by email · Can view", status: on.people ? ["Opens, after signing in", "success", "check"] : ["Opens", "success", "check"] },
    { name: "Sam Lee", initials: "SL", role: "In Acme, not added", status: notAdded },
    { name: "Someone with the link", initials: "?", role: "It was forwarded to them", neutral: true, status: notAdded },
    {
      name: "Markdrop's servers",
      initials: "M",
      role: "Where it's kept",
      neutral: true,
      status: on.e2e ? ["Can't read it", "info", "eyeOff"] : ["Store it", "neutral", "archive"],
    },
  ];
  const level = on.people
    ? "Only people added · You and the people below."
    : `Anyone with the link · ${on.password ? "No sign-in. They're asked for the password." : "No sign-in needed."}`;

  return (
    <section id="sharing" aria-labelledby="sharing-h" className={s.section}>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          <filter id="desk-ink">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="2.5" />
          </filter>
        </defs>
      </svg>
      <div className={s.headRow}>
        <div className={s.headCol} style={{ maxWidth: 560 }}>
          <span className={s.eyebrow}>Who can open it</span>
          <h2 id="sharing-h" className={s.h2}>
            Stamp it, then send it.
          </h2>
          <p className={s.lede}>Press a stamp and watch who gets in change. Press it again to lift it off.</p>
        </div>
        <div className={s.stamps} role="group" aria-label="Access stamps">
          {STAMPS.map((st) => (
            <button
              key={st.id}
              type="button"
              className={`${s.stamp} ${presses[st.id] ? (presses[st.id] % 2 ? s.pressA : s.pressB) : ""}`}
              aria-pressed={on[st.id]}
              onClick={() => press(st.id)}
            >
              <span className={s.stampBody} aria-hidden="true">
                <span className={s.knob} />
                <span className={s.neck} />
                <span className={s.block} />
                <span className={s.rubber}>{st.short}</span>
              </span>
              <span className={s.stampLabel}>{st.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={s.shareGrid}>
        <div className={s.docPaper}>
          <span className={s.docUrl}>
            markdrop.in/<strong>launch-notes</strong>
            {on.e2e && <em>#k=Vq7mT2xL</em>}
          </span>
          <img className={`${s.docShot} ${t.light}`} src="/landing-desk/screens/launch-notes-doc.webp" alt="The Launch notes document as Markdrop renders it: a Mermaid diagram, a table and code." width={1120} height={1488} loading="lazy" decoding="async" />
          <img className={`${s.docShot} ${t.dark}`} src="/landing-desk/screens/launch-notes-doc.dark.webp" alt="The Launch notes document as Markdrop renders it: a Mermaid diagram, a table and code." width={1120} height={1488} loading="lazy" decoding="async" />
          <p className={s.docNote}>A document. Files get a password or an access level instead of end-to-end.</p>
          {(Object.keys(IMPRINT) as StampId[]).map((id) =>
            on[id] ? (
              <span key={`${id}-${presses[id]}`} className={s.imp} style={IMPRINT[id].style} aria-hidden="true">
                {IMPRINT[id].text}
              </span>
            ) : null,
          )}
        </div>

        <div className={s.whoCol}>
          <div className={s.panel}>
            <div className={s.panelHead}>
              <strong>Who gets in</strong>
              <span>{level}</span>
              {on.expiry && <span>It stops opening on Friday.</span>}
            </div>
            {on.e2e && (
              <p className={s.alert}>
                <b>The link is the key.</b> Anyone you share with needs the full link, including everything after the #.
              </p>
            )}
            <ul className={s.people} aria-live="polite" aria-label="Who gets in">
              {rows.map((r) => (
                <li key={r.name} className={s.person}>
                  <span className={s.avatar} data-neutral={r.neutral ? "" : undefined} aria-hidden="true">
                    {r.initials}
                  </span>
                  <span className={s.who}>
                    <b>{r.name}</b>
                    <span>{r.role}</span>
                  </span>
                  <Badge tone={r.status[1]} icon={r.status[2]}>
                    {r.status[0]}
                    {on.expiry && r.status[1] === "success" ? " · until Friday" : ""}
                  </Badge>
                </li>
              ))}
            </ul>
            <div className={s.panelFoot}>
              <span className={s.small}>End-to-end is for documents. Files get a password or an access level.</span>
              <a className={s.more} href={docsUrl(DOCS_PAGES.whoCanOpen)} data-cta="sharing_docs">
                How sharing works
                <Icon name="arrowRight" />
              </a>
            </div>
          </div>
          <figure className={s.figure}>
            <div className={s.screen}>
              <LoopVideo src="/landing-desk/share-dialog" w={880} h={874} label="The Share dialog in Markdrop: Who can open it, set to Only people added; Acme team and Anyone with the link are the other choices." />
            </div>
            <figcaption>The Share dialog in Markdrop, where these settings live.</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
