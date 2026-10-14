/**
 * The miniature scenes the Orbit hero draws: the station's file panes, the desktop dioramas and the
 * mobile screen panes. Hook-free and aria-hidden: they illustrate what the info card says. Text inside
 * these miniatures keeps the boards' sizes (they are pictures of pages, like a screenshot); every piece
 * of interface text outside them is at least 11px.
 */
import type { CSSProperties, ReactNode } from "react";
import S from "./Orbit.module.css";
import { DropSvg, FileIcon, Icon, MarkdropMark, RouteBadge, Badge, VSCodeIcon } from "./ds";
import type { FileDef, FileId, ScreenId } from "./data";

export const k = (...names: Array<string | false | null | undefined>) =>
  names.filter(Boolean).map((n) => S[n as string] ?? (n as string)).join(" ");
/** A style object that may carry custom properties. */
export const v = (o: Record<string, string | number | undefined>) => o as CSSProperties;

const PlaySvg = ({ s }: { s: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
);
const KeySvg = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="8" cy="15" r="4" /><path d="M10.9 12.1 19 4M16 7l2.5 2.5M13.5 9.5l2 2" /></svg>
);

/* ── File panes (shared by the desktop station and the mobile screen) ─── */

function HtmlPane() {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 16 }}>
        <span style={{ width: 14, height: 14, borderRadius: 4, background: "var(--accent)" }} />
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text)" }}>Launch</span>
        <span className={k("sb")} style={{ marginLeft: "auto", width: 24, height: 4 }} />
        <span className={k("sb")} style={{ width: 24, height: 4 }} />
        <span style={{ display: "inline-flex", alignItems: "center", height: 16, padding: "0 8px", borderRadius: 999, background: "var(--text)", color: "var(--bg)", fontSize: 9, fontWeight: 700 }}>Sign up</span>
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 19, lineHeight: "21px", fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text)" }}>Launch day is Friday</span>
          <span className={k("sb")} style={{ width: "92%" }} />
          <span className={k("sb")} style={{ width: "70%" }} />
          <span style={{ alignSelf: "flex-start", marginTop: 3, display: "inline-flex", alignItems: "center", height: 22, padding: "0 10px", borderRadius: 6, background: "var(--accent)", color: "var(--on-accent)", fontSize: 10, fontWeight: 700 }}>Get early access</span>
        </div>
        <div className={k("pg-art")}><span className={k("pg-orb")} /></div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}><span className={k("pg-c")} /><span className={k("pg-c")} /><span className={k("pg-c")} /></div>
    </>
  );
}

function PdfPane() {
  return (
    <>
      <div style={{ width: 150, height: 136, margin: "0 auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 5, borderRadius: 2, background: "var(--surface-raised)", boxShadow: "var(--shadow-md)" }}>
        <span style={{ fontSize: 11, lineHeight: "13px", fontWeight: 800, color: "var(--text)" }}>Q3 report</span>
        <span className={k("sb")} style={{ height: 3 }} />
        <span className={k("sb")} style={{ height: 3, width: "86%" }} />
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 40, margin: "3px 0", padding: "0 4px", borderBottom: "1px solid var(--border-strong)" }}>
          <span style={{ flex: 1, height: "40%", background: "var(--accent-soft)" }} />
          <span style={{ flex: 1, height: "62%", background: "var(--accent-soft)" }} />
          <span style={{ flex: 1, height: "54%", background: "var(--accent-soft)" }} />
          <span style={{ flex: 1, height: "92%", background: "var(--accent)" }} />
        </div>
        <span className={k("sb")} style={{ height: 3 }} />
        <span className={k("sb")} style={{ height: 3, width: "70%" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 22, padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--surface)", borderTop: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-secondary)" }}>
        <span>q3-report.pdf</span><span>1 / 12</span><span>100%</span>
      </div>
    </>
  );
}

function XlsxPane() {
  const rows: Array<[string, string, string, string, string, boolean?]> = [
    ["North", "12.4", "13.1", "14.0", "39.5"],
    ["South", "9.8", "10.2", "11.6", "31.6"],
    ["East", "15.1", "14.7", "16.3", "46.1", true],
    ["West", "8.2", "9.0", "9.9", "27.1"],
  ];
  return (
    <>
      <div className={k("xg")}>
        <span className={k("h")} /><span className={k("h")}>A</span><span className={k("h")}>B</span><span className={k("h")}>C</span><span className={k("h")}>D</span><span className={k("h")}>E</span>
        <span className={k("h")}>1</span><span className={k("k")}>Region</span><span className={k("k")}>Jul</span><span className={k("k")}>Aug</span><span className={k("k")}>Sep</span><span className={k("t")}>Total</span>
        {rows.map((r, i) => (
          <Row key={r[0]} n={i + 2} r={r} />
        ))}
      </div>
      <div className={k("xtabs")}><span className={k("on")}>Summary</span><span>Detail</span></div>
    </>
  );
}
function Row({ n, r }: { n: number; r: [string, string, string, string, string, boolean?] }) {
  return (
    <>
      <span className={k("h")}>{n}</span><span>{r[0]}</span><span>{r[1]}</span><span>{r[2]}</span><span>{r[3]}</span><span className={k("t", r[5] && "sel")}>{r[4]}</span>
    </>
  );
}

function Mp4Pane() {
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, top: 22, bottom: 30, background: "radial-gradient(circle at 25% 35%, var(--accent-soft), transparent 55%), radial-gradient(circle at 78% 70%, color-mix(in srgb, var(--cat-share) 30%, transparent), transparent 50%), var(--code-bg)", display: "grid", placeItems: "center" }}>
        <span style={{ width: 48, height: 48, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--bezel)", color: "var(--logo-ink)", boxShadow: "var(--shadow-lg)" }}><PlaySvg s={18} /></span>
        <span style={{ position: "absolute", left: 10, top: 8, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-secondary)" }}>product-demo.mp4</span>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 30, padding: "0 10px", display: "flex", alignItems: "center", gap: 8, background: "var(--surface)", borderTop: "1px solid var(--border)" }}>
        <span style={{ display: "inline-flex", color: "var(--text)" }}><PlaySvg s={10} /></span>
        <span style={{ flex: 1, position: "relative", height: 4, borderRadius: 999, background: "var(--surface-active)" }}>
          <span style={{ position: "absolute", left: 0, top: 0, width: "34%", height: 4, borderRadius: 999, background: "var(--accent)" }} />
          <span style={{ position: "absolute", left: "34%", top: -3, width: 10, height: 10, marginLeft: -5, borderRadius: "50%", background: "var(--text)" }} />
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-secondary)" }}>0:42 / 2:05</span>
      </div>
    </>
  );
}

function ZipPane() {
  return (
    <>
      <div style={{ width: 96, flex: "none", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 4, background: "var(--surface-inset)", borderRight: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 9.5, lineHeight: "16px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
        <span style={{ fontFamily: "var(--font-sans)", fontSize: 10.5, fontWeight: 800, color: "var(--text)" }}>docs-site</span>
        <span style={{ padding: "0 5px", margin: "0 -5px", borderRadius: 4, background: "var(--surface-active)", color: "var(--text)" }}>index.html</span>
        <span>guide/</span><span>api/</span><span>about.html</span>
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 15, lineHeight: "18px", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text)" }}>Welcome</span>
        <span className={k("sb")} style={{ width: "92%" }} />
        <span className={k("sb")} style={{ width: "76%" }} />
        <div style={{ marginTop: 2, padding: "7px 8px", borderRadius: 5, background: "var(--code-bg)", border: "1px solid var(--code-border)", display: "flex", flexDirection: "column", gap: 4 }}>
          <span className={k("sb")} style={{ width: "60%", background: "var(--code-inline)" }} />
          <span className={k("sb")} style={{ width: "80%", background: "var(--accent-text)" }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-text)" }}>Next: Install</span>
      </div>
    </>
  );
}

const PANE_STYLE: Record<FileId, CSSProperties> = {
  html: {},
  pdf: { background: "var(--surface-inset)", padding: "24px 0 0" },
  xlsx: { padding: "26px 10px 0" },
  mp4: { padding: "22px 0 0" },
  zip: { padding: "22px 0 0", display: "flex" },
};
const PANE_BODY: Record<FileId, () => ReactNode> = { html: HtmlPane, pdf: PdfPane, xlsx: XlsxPane, mp4: Mp4Pane, zip: ZipPane };

/** Desktop station: all five panes stay mounted and cross-fade (opacity transition with --pd delay). */
export function StationPanes({ file }: { file: FileId }) {
  return (
    <>
      {(Object.keys(PANE_BODY) as FileId[]).map((id) => {
        const Body = PANE_BODY[id];
        return <div key={id} className={k("pane", id === file && "on")} style={PANE_STYLE[id]}><Body /></div>;
      })}
    </>
  );
}

/* ── Desktop dioramas: a pop-up book that unfolds under the docked moon ── */

/** `a` = whether this mount animates (false on the poster and the game's first frame). */
interface DioProps { a: boolean }
const an = (a: boolean, ...rest: Array<string | false>) => k(...rest, a && "anim");

function Plate() {
  return <><div className={k("plate-rim")} /><div className={k("plate")} /></>;
}

function DioPublish({ a }: DioProps) {
  return (
    <div className={k("dio-sc")} aria-hidden="true">
      <Plate />
      <div className={k("csh")} style={{ left: 40, top: 188, width: 172 }} />
      <div className={k("csh")} style={{ left: 274, top: 188, width: 176 }} />
      <div className={an(a, "toy", "codey", "pop")} style={{ left: 32, top: 38, width: 180, height: 158 }}>
        <div className={k("t-hd")}><span style={{ display: "inline-flex", color: "var(--cat-document)" }}><Icon name="lines" size={12} /></span>release-notes.md</div>
        <div className={k("m10")} style={{ padding: "8px 10px", color: "var(--text)" }}>
          <div className={an(a, "ty")} style={v({ "--d": "1.25s" })}><span style={{ color: "var(--accent-text)" }}># </span><b>Release notes</b></div>
          <div className={an(a, "ty")} style={v({ "--d": "1.4s" })}><span className={k("mu")}>- </span>Code in colour</div>
          <div className={an(a, "ty")} style={v({ "--d": "1.55s" })}><span className={k("mu")}>- </span>Diagrams too</div>
          <div className={an(a, "ty", "mu")} style={v({ "--d": "1.7s" })}>```mermaid</div>
          <div className={an(a, "ty")} style={v({ "--d": "1.85s" })}>Write <span style={{ color: "var(--code-inline)" }}>--&gt;</span> Link</div>
          <div className={an(a, "ty", "mu")} style={v({ "--d": "2s" })}>```</div>
        </div>
      </div>
      <div className={an(a, "toy", "pop")} style={v({ left: 272, top: 26, width: 180, height: 170, "--d": ".12s" })}>
        <div className={k("t-chrome")}><span className={k("dots")}><i /><i /><i /></span><span className={k("t-addr")}><span className={k("mu")}>markdrop.in/</span>release-notes</span></div>
        <div className={an(a, "rv")} style={v({ "--d": "2.25s", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontSize: 14, lineHeight: "17px", fontWeight: 800, letterSpacing: "-0.01em", color: "var(--text)" }}>Release notes</span><span className={k("live")}>Live</span></div>
          <div className={k("bl")}><i />Code in colour</div>
          <div className={k("bl")}><i />Diagrams too</div>
          <svg width="150" height="30" viewBox="0 0 150 30" aria-hidden="true" style={{ marginTop: 4 }}>
            <rect x="1" y="5" width="58" height="20" rx="5" style={{ fill: "var(--surface-raised)", stroke: "var(--border-strong)" }} />
            <text x="30" y="19" textAnchor="middle" style={{ fill: "var(--text)", font: "600 11px var(--font-sans)" }}>Write</text>
            <path d="M62 15h18" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} /><path d="m77 12 3 3-3 3" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} />
            <rect x="85" y="5" width="58" height="20" rx="5" style={{ fill: "var(--accent-soft)", stroke: "var(--accent-text)" }} />
            <text x="114" y="19" textAnchor="middle" style={{ fill: "var(--accent-text)", font: "700 11px var(--font-sans)" }}>Link</text>
          </svg>
        </div>
      </div>
      <div className={an(a, "pub-btn", "pop")} style={v({ left: 200, top: 92, "--d": ".3s" })}><MarkdropMark size={12} />Publish</div>
      <div className={an(a, "rider", "flyd")} style={{ offsetPath: "path('M 214 82 Q 248 30 292 64')" }}><DropSvg w={12} h={15} pathCls={k("drop-p")} /></div>
    </div>
  );
}

function DioEncrypt({ a }: DioProps) {
  return (
    <div className={k("dio-sc")} aria-hidden="true">
      <Plate />
      <div className={k("csh")} style={{ left: 36, top: 192, width: 140 }} />
      <div className={an(a, "toy", "pop")} style={v({ left: 250, top: 16, width: 212, height: 54, "--d": ".1s" })}>
        <div style={{ padding: "9px 10px 0", display: "flex", alignItems: "center", gap: 6, fontSize: 11, lineHeight: 1, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}><span style={{ display: "inline-flex", color: "var(--text-muted)" }}><Icon name="globe" size={12} /></span>Markdrop server<span className={k("mu")} style={{ marginLeft: "auto", fontSize: 10, fontWeight: 500 }}>ciphertext only</span></div>
        <div className={k("m10", "mu")} style={{ padding: "5px 10px 0", whiteSpace: "nowrap", overflow: "hidden" }}><span className={k("scroll", "loop")}>9f3a c1e0 7b42 d9a8 03fe 6c1b&#160;9f3a c1e0 7b42 d9a8 03fe 6c1b&#160;</span></div>
      </div>
      <div className={an(a, "toy", "pop")} style={{ left: 30, top: 62, width: 142, height: 138 }}>
        <div className={k("vault-in")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: "var(--text)" }}><Icon name="lines" size={12} />plan.md</span>
          <span className={k("sb")} style={{ height: 4 }} /><span className={k("sb")} style={{ height: 4, width: "80%" }} /><span className={k("sb")} style={{ height: 4, width: "64%" }} />
        </div>
        <div className={an(a, "door")}><span className={k("dial")} /></div>
      </div>
      <div className={an(a, "u-chip", "pop")} style={v({ left: 186, top: 104, "--d": ".45s" })}><span className={an(a, "u-path")}>markdrop.in/plan</span><span className={an(a, "u-key")}><KeySvg />#k=7Qx2…</span></div>
      <div className={an(a, "toy", "pop")} style={v({ left: 250, top: 178, width: 212, height: 42, "--d": ".2s" })}>
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", fontSize: 11, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}>Your browser<span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, color: "var(--text-secondary)" }}>Decrypts here<span style={{ display: "inline-flex", color: "var(--success)" }}><Icon name="check" size={12} /></span></span></div>
      </div>
      <div className={an(a, "m11", "mu", "pop")} style={v({ position: "absolute", left: 34, top: 214, "--d": ".5s" })}>AES-256-GCM, in your browser</div>
    </div>
  );
}

function PhoneScreen({ f }: { f: FileId }) {
  if (f === "html") return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ height: 46, borderRadius: 6, background: "linear-gradient(135deg, color-mix(in srgb, var(--accent) 34%, var(--surface)), var(--surface-inset))" }} />
      <span style={{ fontSize: 9, lineHeight: "10px", fontWeight: 800, color: "var(--text)" }}>Launch day is Friday</span>
      <span className={k("sb")} style={{ height: 3 }} /><span className={k("sb")} style={{ height: 3, width: "70%" }} />
      <span style={{ alignSelf: "flex-start", height: 12, width: 44, borderRadius: 4, background: "var(--accent)" }} />
    </div>
  );
  if (f === "pdf") return (
    <div style={{ flex: 1, borderRadius: 4, background: "var(--surface-inset)", padding: 6, display: "flex" }}>
      <div style={{ flex: 1, padding: 6, display: "flex", flexDirection: "column", gap: 4, background: "var(--surface-raised)", boxShadow: "var(--shadow-sm)" }}>
        <span style={{ fontSize: 8, fontWeight: 800, color: "var(--text)" }}>Q3 report</span>
        <span className={k("sb")} style={{ height: 3 }} /><span className={k("sb")} style={{ height: 3, width: "80%" }} />
        <span style={{ height: 22, background: "var(--accent-soft)" }} />
        <span className={k("sb")} style={{ height: 3, width: "60%" }} />
      </div>
    </div>
  );
  if (f === "xlsx") return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 8, fontWeight: 800, color: "var(--text)" }}>Summary</span>
      <span style={{ height: 84, borderTop: "1px solid var(--border)", borderLeft: "1px solid var(--border)", backgroundImage: "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px), linear-gradient(90deg, transparent 72%, var(--success-soft) 72%)", backgroundSize: "100% 12px, 19px 100%, 100% 100%" }} />
    </div>
  );
  if (f === "mp4") return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ height: 52, borderRadius: 5, display: "grid", placeItems: "center", background: "radial-gradient(circle at 30% 30%, var(--accent-soft), transparent 60%), var(--code-bg)" }}><span style={{ width: 20, height: 20, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--bezel)", color: "var(--logo-ink)" }}><PlaySvg s={8} /></span></span>
      <span style={{ position: "relative", height: 3, borderRadius: 2, background: "var(--surface-active)" }}><span style={{ position: "absolute", left: 0, top: 0, width: "34%", height: 3, borderRadius: 2, background: "var(--accent)" }} /></span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 7.5, color: "var(--text-muted)" }}>0:42 / 2:05</span>
    </div>
  );
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ display: "flex", gap: 3 }}><span style={{ height: 10, flex: 1, borderRadius: 3, background: "var(--surface-active)" }} /><span style={{ height: 10, flex: 1, borderRadius: 3, background: "var(--surface-inset)" }} /><span style={{ height: 10, flex: 1, borderRadius: 3, background: "var(--surface-inset)" }} /></span>
      <span style={{ fontSize: 9, fontWeight: 800, color: "var(--text)" }}>Welcome</span>
      <span className={k("sb")} style={{ height: 3 }} /><span className={k("sb")} style={{ height: 3, width: "76%" }} />
      <span style={{ height: 22, borderRadius: 3, background: "var(--code-bg)", border: "1px solid var(--code-border)" }} />
    </div>
  );
}

function DioRender({ a, file, combo }: DioProps & { file: FileDef; combo: boolean }) {
  return (
    <div className={k("dio-sc")} aria-hidden="true">
      <Plate />
      <div className={k("csh")} style={{ left: 34, top: 190, width: 132 }} />
      <div className={k("csh")} style={{ left: 378, top: 192, width: 90 }} />
      <div className={an(a, "toy", "pop")} style={v({ left: 30, top: 36, width: 132, height: 162, "--d": ".05s" })}>
        <span className={k("fold")} />
        <div style={{ height: "100%", padding: "18px 10px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
          <span style={{ width: 56, height: 56, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--surface-inset)", border: "1px solid var(--border)" }}><FileIcon name={file.name} mime={file.mime} size={28} /></span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: "14px", color: "var(--text)", wordBreak: "break-all" }}>{file.name}</span>
          {combo ? <Badge tone="warning" icon="lock">Password</Badge> : <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Uploaded</span>}
        </div>
      </div>
      <div className={an(a, "r-link", "pop")} style={v({ left: 174, top: 96, "--d": ".4s" })}><MarkdropMark size={14} /><span><span className={k("mu")}>markdrop.in/</span>{file.slug}</span></div>
      <div className={an(a, "toy", "dev", "pop")} style={v({ left: 380, top: 20, width: 86, height: 176, borderRadius: 16, "--d": ".2s" })}>
        <div className={k("ph-in")}>
          <span className={k("ph-notch")} />
          <span style={{ height: 8, borderRadius: 999, background: "var(--surface-inset)", flex: "none" }} />
          <PhoneScreen f={file.id} />
        </div>
      </div>
      <div className={an(a, "r-cap", "pop")} style={v({ left: 168, top: 218, "--d": ".6s" })}>Opens in the browser. No download, no app.</div>
    </div>
  );
}

function DioSync({ a }: DioProps) {
  return (
    <div className={k("dio-sc")} aria-hidden="true">
      <Plate />
      <div className={k("csh")} style={{ left: 24, top: 178, width: 216 }} />
      <div className={k("csh")} style={{ left: 302, top: 182, width: 156 }} />
      <div className={an(a, "pop")} style={v({ position: "absolute", left: 12, top: 158, width: 224, height: 22, "--d": ".05s" })}><div className={k("kb")} /></div>
      <div className={an(a, "toy", "dev", "pop")} style={{ left: 24, top: 22, width: 200, height: 136 }}>
        <div className={k("lap-in")}>
          <div className={k("vs-t")}><span style={{ display: "inline-flex", color: "var(--cat-sync)" }}><VSCodeIcon size={10} /></span>release-notes.md</div>
          <div className={k("m10")} style={{ padding: "6px 0", whiteSpace: "nowrap", color: "var(--text)" }}>
            <div><span className={k("g")}>1</span><span style={{ color: "var(--accent-text)" }}># </span>Release notes</div>
            <div className={k("vl")}><span className={k("g")}>2</span><span className={k("mu")}>- </span>Faster export<span className={an(a, "ty")} style={v({ "--d": "1.6s", display: "inline-block" })}>&#160;to PDF</span></div>
            <div><span className={k("g")}>3</span><span className={k("mu")}>- </span>Live reload</div>
            <div><span className={k("g")}>4</span><span className={k("mu")}>- </span>Dark mode</div>
          </div>
          <div className={k("vs-st")}><span className={an(a, "st-a")}>Markdrop: Syncing…</span><span className={an(a, "st-b")}><Icon name="check" size={10} />Markdrop: Synced</span></div>
        </div>
      </div>
      <div className={an(a, "toy", "pop")} style={v({ left: 300, top: 30, width: 160, height: 160, "--d": ".15s" })}>
        <div className={k("t-chrome")}><span className={k("dots")}><i /><i /><i /></span><span className={k("t-addr")}><span className={k("mu")}>markdrop.in/</span>release-notes</span></div>
        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
          <span style={{ fontSize: 13, lineHeight: "16px", fontWeight: 800, color: "var(--text)" }}>Release notes</span>
          <span className={k("flash")}><span className={an(a, "flash-bg")} /><span className={an(a, "grow")} /></span>
          <span className={k("sb")} style={{ width: "72%" }} />
          <span className={k("sb")} style={{ width: "58%" }} />
          <span className={k("live")} style={{ marginTop: 4 }}>Updated just now</span>
        </div>
      </div>
      <div className={k("rider", "pls", "loop")} style={{ offsetPath: "path('M 226 70 Q 263 22 300 70')", animationDelay: "2s" }}><i /></div>
      <div className={k("rider", "pls", "loop")} style={{ offsetPath: "path('M 300 132 Q 263 180 226 132')", animationDelay: "3.6s" }}><i /></div>
      <div className={an(a, "m11", "mu", "pop")} style={v({ position: "absolute", left: 242, top: 22, "--d": ".5s" })}>save</div>
      <div className={an(a, "m11", "mu", "pop")} style={v({ position: "absolute", left: 243, top: 160, "--d": ".5s" })}>edit</div>
    </div>
  );
}

function Packets({ path }: { path: string }) {
  return (
    <>
      {[["0s", "18%"], ["-.6s", "40%"], ["-1.2s", "62%"], ["-1.8s", "84%"]].map(([d, rest]) => (
        <div key={d} className={k("rider", "pkt", "loop")} style={v({ offsetPath: path, animationDelay: d, "--rest": rest })}><i /></div>
      ))}
    </>
  );
}

function DioSend({ a, send, onRelay }: DioProps & { send: { relay: boolean; d: string; path: string; route: "relay" | "direct"; btn: string }; onRelay?: () => void }) {
  return (
    <>
      <div className={k("dio-sc")} aria-hidden="true">
        <Plate />
        <div className={k("csh")} style={{ left: 16, top: 168, width: 160 }} />
        <div className={k("csh")} style={{ left: 380, top: 168, width: 84 }} />
        <div className={an(a, "pop")} style={v({ position: "absolute", left: 12, top: 154, width: 156, height: 18, "--d": ".05s" })}><div className={k("kb")} /></div>
        <div className={an(a, "toy", "dev", "pop")} style={{ left: 22, top: 62, width: 136, height: 92 }}>
          <div className={k("lap-in")} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3 }}>
            <span style={{ display: "inline-flex", color: "var(--cat-share)" }}><Icon name="folder" size={20} /></span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>photos</span>
            <span className={k("m10", "mu")}>48 files</span>
          </div>
        </div>
        <div className={an(a, "toy", "dev", "pop")} style={v({ left: 382, top: 30, width: 78, height: 140, borderRadius: 16, "--d": ".15s" })}>
          <div className={k("ph-in")}>
            <span className={k("ph-notch")} />
            <span style={{ fontSize: 8, fontWeight: 600, color: "var(--text-muted)" }}>Receiving</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text)" }}>photos</span>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--surface-inset)", border: "1px solid var(--border)" }} /><span className={k("sb")} style={{ flex: 1, height: 3 }} /></span>
            ))}
            <span style={{ position: "relative", height: 4, borderRadius: 2, background: "var(--surface-active)", marginTop: "auto" }}><span style={{ position: "absolute", left: 0, top: 0, width: "62%", height: 4, borderRadius: 2, background: "var(--accent)" }} /></span>
          </div>
        </div>
        <svg className={k("spath")} width="480" height="270" viewBox="0 0 480 270" aria-hidden="true"><path d={send.d} /></svg>
        {send.relay && (
          <div className={k("toy", "pop", "anim")} style={v({ left: 206, top: 6, width: 128, height: 40, "--b": "0s" })}>
            <div style={{ height: "100%", padding: "0 10px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 3, whiteSpace: "nowrap" }}><span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: "var(--text)" }}><Icon name="wave" size={12} />Encrypted relay</span><span style={{ fontSize: 9.5, color: "var(--text-muted)" }}>Cannot read the bytes</span></div>
          </div>
        )}
        <Packets path={send.path} />
        <div style={{ position: "absolute", left: 236, top: 122, transform: "translateX(-50%)" }}><RouteBadge route={send.route} /></div>
        <div className={an(a, "cli", "pop")} style={v({ left: 22, top: 212, "--d": ".4s" })}><span className={k("mu")}>$&#160;</span>markdrop send ./photos</div>
      </div>
      {onRelay && (
        <button type="button" className={k("dio-btn")} style={{ left: 262, top: 202 }} aria-pressed={send.relay} onClick={onRelay}><Icon name="wave" size={14} />{send.btn}</button>
      )}
    </>
  );
}

function DioDomain({ a }: DioProps) {
  return (
    <div className={k("dio-sc")} aria-hidden="true">
      <Plate />
      <div className={k("csh")} style={{ left: 70, top: 186, width: 340 }} />
      <div className={an(a, "toy", "pop")} style={{ left: 64, top: 14, width: 352, height: 182 }}>
        <div className={k("t-chrome")} style={{ height: 28 }}>
          <span className={k("slot")} style={{ width: 14, height: 14 }}><span className={an(a, "d-old")}><MarkdropMark size={14} /></span><span className={an(a, "d-new", "brand-tile")}>E</span></span>
          <span className={k("t-addr")} style={{ position: "relative", height: 16 }}><span className={an(a, "d-old")} style={{ position: "absolute", left: 8, top: 1 }}><span className={k("mu")}>markdrop.in/</span>onboarding</span><span className={an(a, "d-new")} style={{ position: "absolute", left: 8, top: 1 }}><span className={k("mu")}>docs.example.com/</span>guides/onboarding</span></span>
        </div>
        <div style={{ display: "flex", height: 152 }}>
          <div style={{ width: 108, flex: "none", padding: "9px 8px", display: "flex", flexDirection: "column", gap: 5, background: "var(--surface-inset)", borderRight: "1px solid var(--border)", fontSize: 10.5, lineHeight: "15px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
            <span className={k("slot")} style={{ height: 15, fontWeight: 800, color: "var(--text)" }}><span className={an(a, "d-old")}>markdrop</span><span className={an(a, "d-new")}>Example Docs</span></span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="folder" size={11} />Guides</span>
            <span style={{ marginLeft: 14, padding: "0 5px", borderRadius: 4, background: "var(--surface-active)", color: "var(--text)", fontWeight: 600 }}>Onboarding</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="folder" size={11} />Policies</span>
          </div>
          <div style={{ flex: 1, minWidth: 0, position: "relative", padding: 12, display: "flex", flexDirection: "column", gap: 7 }}>
            <span className={an(a, "d-old")} style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: "var(--accent)" }} />
            <span className={an(a, "d-new")} style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: "var(--cat-builder)" }} />
            <span style={{ fontSize: 14, lineHeight: "17px", fontWeight: 800, color: "var(--text)" }}>Onboarding guide</span>
            <span className={k("sb")} style={{ width: "92%" }} /><span className={k("sb")} style={{ width: "74%" }} /><span className={k("sb")} style={{ width: "84%" }} />
            <span style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", fontSize: 10, color: "var(--text-muted)" }}><Icon name="lock" size={11} />Workspace only</span>
          </div>
        </div>
      </div>
      <div className={an(a, "pop")} style={v({ position: "absolute", left: 92, top: 214, display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1, color: "var(--text-muted)", whiteSpace: "nowrap", "--d": ".35s" })}><span className={k("pc")}>docs.example.com</span>/<span className={k("pc")}>guides</span>/<span className={k("pc")}>onboarding</span><span style={{ marginLeft: 6, fontFamily: "var(--font-sans)", fontSize: 11 }}>folders are paths</span></div>
    </div>
  );
}

function DioBuilder({ a }: DioProps) {
  const blocks: Array<[string, string, string | null, boolean?]> = [
    ["32px", "1.3s", null], ["68px", "1.5s", "code"], ["104px", "1.7s", "mermaid", true], ["140px", "1.9s", null],
  ];
  const labels = ["Title and badges", "Installation", "Architecture", "License"];
  return (
    <div className={k("dio-sc")} aria-hidden="true">
      <Plate />
      <div className={k("csh")} style={{ left: 26, top: 186, width: 200 }} />
      <div className={k("csh")} style={{ left: 252, top: 186, width: 206 }} />
      <div className={an(a, "toy", "pop")} style={{ left: 22, top: 14, width: 206, height: 182 }}>
        <div className={k("t-hd")}><span style={{ display: "inline-flex", color: "var(--cat-builder)" }}><Icon name="builder" size={12} /></span>Sections</div>
        {blocks.map(([top, d, em, hl], i) => (
          <div key={top} className={an(a, "blk")} style={v({ top, "--d": d, borderColor: hl ? "var(--cat-builder)" : undefined })}><span className={k("hd")}>⋮⋮</span>{labels[i]}{em && <em>{em}</em>}</div>
        ))}
      </div>
      <div className={an(a, "toy", "pop")} style={v({ left: 250, top: 10, width: 210, height: 186, "--d": ".12s" })}>
        <div className={k("t-hd")}><Icon name="doc" size={12} />README.md</div>
        <div className={an(a, "rv")} style={v({ "--d": "2.4s", padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6 })}>
          <span style={{ fontSize: 13, lineHeight: "16px", fontWeight: 800, color: "var(--text)" }}>my-project</span>
          <span style={{ display: "flex", gap: 4 }}><span style={{ width: 34, height: 9, borderRadius: 3, background: "var(--success-soft)", border: "1px solid var(--success)" }} /><span style={{ width: 28, height: 9, borderRadius: 3, background: "var(--accent-soft)", border: "1px solid var(--accent-text)" }} /><span style={{ width: 24, height: 9, borderRadius: 3, background: "var(--surface-inset)", border: "1px solid var(--border-strong)" }} /></span>
          <span className={k("m10")} style={{ padding: "3px 6px", borderRadius: 4, background: "var(--code-bg)", border: "1px solid var(--code-border)", color: "var(--text)" }}>npm i my-project</span>
          <svg width="186" height="22" viewBox="0 0 186 22" aria-hidden="true">
            <rect x="1" y="2" width="50" height="18" rx="4" style={{ fill: "var(--surface-raised)", stroke: "var(--border-strong)" }} /><text x="26" y="15" textAnchor="middle" style={{ fill: "var(--text)", font: "600 9.5px var(--font-sans)" }}>Install</text>
            <path d="M53 11h12" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} />
            <rect x="67" y="2" width="50" height="18" rx="4" style={{ fill: "var(--surface-raised)", stroke: "var(--border-strong)" }} /><text x="92" y="15" textAnchor="middle" style={{ fill: "var(--text)", font: "600 9.5px var(--font-sans)" }}>Use</text>
            <path d="M119 11h12" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} />
            <rect x="133" y="2" width="50" height="18" rx="4" style={{ fill: "var(--accent-soft)", stroke: "var(--accent-text)" }} /><text x="158" y="15" textAnchor="middle" style={{ fill: "var(--accent-text)", font: "700 9.5px var(--font-sans)" }}>Ship</text>
          </svg>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>MIT License</span>
        </div>
      </div>
      <div className={an(a, "chip", "pop")} style={v({ left: 168, top: 216, "--d": "1.55s" })}><Icon name="arrowRight" size={12} />Publish</div>
      <div className={an(a, "chip", "pop")} style={v({ left: 254, top: 216, "--d": "1.65s" })}><Icon name="download" size={12} />Export to PDF</div>
    </div>
  );
}

export function Diorama({ dock, a, file, combo, send, onRelay }: {
  dock: string | null; a: boolean; file: FileDef; combo: boolean;
  send: { relay: boolean; d: string; path: string; route: "relay" | "direct"; btn: string };
  onRelay?: () => void;
}) {
  if (!dock) return null;
  let body: ReactNode = null;
  if (dock === "publish") body = <DioPublish a={a} />;
  else if (dock === "encrypt") body = <DioEncrypt a={a} />;
  else if (dock === "render") body = <DioRender a={a} file={file} combo={combo} />;
  else if (dock === "sync") body = <DioSync a={a} />;
  else if (dock === "send") body = <DioSend a={a} send={send} onRelay={onRelay} />;
  else if (dock === "domain") body = <DioDomain a={a} />;
  else if (dock === "builder") body = <DioBuilder a={a} />;
  return <div className={k("dio", a && "anim")}>{body}</div>;
}

/* ── Mobile screen panes: every feature renders ON the screen ─────────── */

function MPublish({ a }: DioProps) {
  return (
    <>
      <div className={k("toy", "codey")} style={{ left: 12, top: 28, width: 132, height: 152 }}>
        <div className={k("t-hd")}><span style={{ display: "inline-flex", color: "var(--cat-document)" }}><Icon name="lines" size={12} /></span>release-notes.md</div>
        <div className={k("m11")} style={{ padding: "8px 10px", color: "var(--text)" }}>
          <div className={an(a, "ty")} style={v({ "--d": ".1s" })}><span style={{ color: "var(--accent-text)" }}># </span><b>Release notes</b></div>
          <div className={an(a, "ty")} style={v({ "--d": ".25s" })}><span className={k("mu")}>- </span>Code in colour</div>
          <div className={an(a, "ty")} style={v({ "--d": ".4s" })}><span className={k("mu")}>- </span>Diagrams too</div>
          <div className={an(a, "ty", "mu")} style={v({ "--d": ".55s" })}>```mermaid</div>
          <div className={an(a, "ty")} style={v({ "--d": ".7s" })}>Write <span style={{ color: "var(--code-inline)" }}>--&gt;</span> Link</div>
          <div className={an(a, "ty", "mu")} style={v({ "--d": ".85s" })}>```</div>
        </div>
      </div>
      <div className={an(a, "rider", "flyd")} style={{ offsetPath: "path('M 146 76 Q 158 44 172 70')" }}><DropSvg w={14} h={18} pathCls={k("drop-p")} /></div>
      <div className={k("toy")} style={{ left: 170, top: 28, width: 132, height: 152 }}>
        <div className={k("t-chrome")}><span className={k("dots")}><i /><i /><i /></span><span className={k("t-addr")}><span className={k("mu")}>markdrop.in/</span>release-notes</span></div>
        <div className={an(a, "rv")} style={v({ "--d": "1.15s", padding: "9px 10px", display: "flex", flexDirection: "column", gap: 6 })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontSize: 13, lineHeight: "16px", fontWeight: 800, color: "var(--text)" }}>Release notes</span><span className={k("live")}>Live</span></div>
          <div className={k("bl")}><i />Code in colour</div>
          <div className={k("bl")}><i />Diagrams too</div>
          <svg width="112" height="26" viewBox="0 0 112 26" aria-hidden="true" style={{ marginTop: 4 }}>
            <rect x="1" y="3" width="44" height="20" rx="5" style={{ fill: "var(--surface-raised)", stroke: "var(--border-strong)" }} />
            <text x="23" y="17" textAnchor="middle" style={{ fill: "var(--text)", font: "600 10px var(--font-sans)" }}>Write</text>
            <path d="M48 13h14" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} /><path d="m59 10 3 3-3 3" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} />
            <rect x="66" y="3" width="44" height="20" rx="5" style={{ fill: "var(--accent-soft)", stroke: "var(--accent-text)" }} />
            <text x="88" y="17" textAnchor="middle" style={{ fill: "var(--accent-text)", font: "700 10px var(--font-sans)" }}>Link</text>
          </svg>
        </div>
      </div>
    </>
  );
}

function MEncrypt({ a }: DioProps) {
  return (
    <>
      <div className={k("toy")} style={{ left: 12, top: 30, width: 104, height: 132 }}>
        <div className={k("vault-in")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "var(--text)" }}><Icon name="lines" size={12} />plan.md</span>
          <span className={k("sb")} style={{ height: 4 }} /><span className={k("sb")} style={{ height: 4, width: "80%" }} /><span className={k("sb")} style={{ height: 4, width: "64%" }} />
        </div>
        <div className={an(a, "door")}><span className={k("dial")} /></div>
      </div>
      <div className={k("toy")} style={{ left: 128, top: 28, width: 174, height: 46 }}>
        <div style={{ padding: "8px 10px 0", display: "flex", alignItems: "center", gap: 6, fontSize: 11, lineHeight: 1, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}><span style={{ display: "inline-flex", color: "var(--text-muted)" }}><Icon name="globe" size={12} /></span>Markdrop server<span className={k("mu")} style={{ marginLeft: "auto", fontSize: 9.5, fontWeight: 500 }}>ciphertext only</span></div>
        <div className={k("m10", "mu")} style={{ padding: "5px 10px 0", whiteSpace: "nowrap", overflow: "hidden" }}><span className={k("scroll", "loop")}>9f3a c1e0 7b42 d9a8 03fe 6c1b&#160;9f3a c1e0 7b42 d9a8 03fe 6c1b&#160;</span></div>
      </div>
      <div className={k("u-chip")} style={{ left: 124, top: 92 }}><span className={an(a, "u-path")}>markdrop.in/plan</span><span className={an(a, "u-key")}><KeySvg />#k=7Qx2…</span></div>
      <div className={k("toy")} style={{ left: 128, top: 142, width: 174, height: 36 }}>
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", fontSize: 11, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}>Your browser<span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, color: "var(--text-secondary)" }}>Decrypts here<span style={{ display: "inline-flex", color: "var(--success)" }}><Icon name="check" size={12} /></span></span></div>
      </div>
    </>
  );
}

function MSync({ a }: DioProps) {
  return (
    <>
      <div style={{ position: "absolute", left: 6, top: 150, width: 172, height: 18 }}><div className={k("kb")} /></div>
      <div className={k("toy", "dev")} style={{ left: 12, top: 30, width: 160, height: 120 }}>
        <div className={k("lap-in")}>
          <div className={k("vs-t")}><span style={{ display: "inline-flex", color: "var(--cat-sync)" }}><VSCodeIcon size={10} /></span>release-notes.md</div>
          <div className={k("m10")} style={{ padding: "6px 0", whiteSpace: "nowrap", color: "var(--text)" }}>
            <div><span className={k("g")}>1</span><span style={{ color: "var(--accent-text)" }}># </span>Release notes</div>
            <div className={k("vl")}><span className={k("g")}>2</span><span className={k("mu")}>- </span>Faster export<span className={an(a, "ty")} style={v({ "--d": ".9s", display: "inline-block" })}>&#160;to PDF</span></div>
            <div><span className={k("g")}>3</span><span className={k("mu")}>- </span>Live reload</div>
            <div><span className={k("g")}>4</span><span className={k("mu")}>- </span>Dark mode</div>
          </div>
          <div className={k("vs-st")}><span className={an(a, "st-a")}>Markdrop: Syncing…</span><span className={an(a, "st-b")}><Icon name="check" size={10} />Markdrop: Synced</span></div>
        </div>
      </div>
      <div className={k("toy")} style={{ left: 196, top: 34, width: 106, height: 118 }}>
        <div className={k("t-chrome")}><span className={k("dots")}><i /><i /><i /></span></div>
        <div style={{ padding: "9px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
          <span style={{ fontSize: 12, lineHeight: "15px", fontWeight: 800, color: "var(--text)" }}>Release notes</span>
          <span className={k("flash")}><span className={an(a, "flash-bg")} /><span className={an(a, "grow")} /></span>
          <span className={k("sb")} style={{ width: "72%" }} />
          <span className={k("sb")} style={{ width: "58%" }} />
          <span className={k("live")} style={{ marginTop: 3 }}>Updated</span>
        </div>
      </div>
      <div className={k("rider", "pls", "loop")} style={{ offsetPath: "path('M 172 64 Q 184 36 196 64')", animationDelay: "1.2s" }}><i /></div>
      <div className={k("rider", "pls", "loop")} style={{ offsetPath: "path('M 196 124 Q 184 152 172 124')", animationDelay: "2.8s" }}><i /></div>
      <div className={k("m10", "mu")} style={{ position: "absolute", left: 172, top: 24 }}>save</div>
      <div className={k("m10", "mu")} style={{ position: "absolute", left: 173, top: 150 }}>edit</div>
    </>
  );
}

function MSend({ send }: { send: { relay: boolean; d: string; path: string; route: "relay" | "direct" } }) {
  return (
    <>
      <div style={{ position: "absolute", left: 6, top: 140, width: 116, height: 14 }}><div className={k("kb")} /></div>
      <div className={k("toy", "dev")} style={{ left: 12, top: 64, width: 104, height: 76 }}>
        <div className={k("lap-in")} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3 }}>
          <span style={{ display: "inline-flex", color: "var(--cat-share)" }}><Icon name="folder" size={20} /></span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>photos</span>
          <span className={k("m10", "mu")}>48 files</span>
        </div>
      </div>
      <div className={k("toy", "dev")} style={{ left: 244, top: 30, width: 60, height: 116, borderRadius: 12 }}>
        <div className={k("ph-in")}>
          <span className={k("ph-notch")} />
          <span style={{ fontSize: 8, fontWeight: 600, color: "var(--text-muted)" }}>Receiving</span>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--text)" }}>photos</span>
          {[0, 1].map((i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--surface-inset)", border: "1px solid var(--border)" }} /><span className={k("sb")} style={{ flex: 1, height: 3 }} /></span>
          ))}
          <span style={{ position: "relative", height: 4, borderRadius: 2, background: "var(--surface-active)", marginTop: "auto" }}><span style={{ position: "absolute", left: 0, top: 0, width: "62%", height: 4, borderRadius: 2, background: "var(--accent)" }} /></span>
        </div>
      </div>
      <svg className={k("spath")} width="314" height="190" viewBox="0 0 314 190" aria-hidden="true"><path d={send.d} /></svg>
      {send.relay && (
        <div className={k("toy")} style={{ left: 124, top: 22, width: 112, height: 34 }}>
          <div style={{ height: "100%", padding: "0 8px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, whiteSpace: "nowrap" }}><span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--text)" }}><Icon name="wave" size={10} />Encrypted relay</span><span style={{ fontSize: 9, color: "var(--text-muted)" }}>Cannot read the bytes</span></div>
        </div>
      )}
      <Packets path={send.path} />
      <div style={{ position: "absolute", left: 180, top: 116, transform: "translateX(-50%)" }}><RouteBadge route={send.route} /></div>
      <div className={k("cli")} style={{ left: 12, top: 160 }}><span className={k("mu")}>$&#160;</span>markdrop send ./photos</div>
    </>
  );
}

function MDomain({ a }: DioProps) {
  return (
    <>
      <div className={k("toy")} style={{ left: 12, top: 26, width: 290, height: 130 }}>
        <div className={k("t-chrome")} style={{ height: 26 }}>
          <span className={k("slot")} style={{ width: 14, height: 14 }}><span className={an(a, "d-old")}><MarkdropMark size={14} /></span><span className={an(a, "d-new", "brand-tile")}>E</span></span>
          <span className={k("t-addr")} style={{ position: "relative", height: 16 }}><span className={an(a, "d-old")} style={{ position: "absolute", left: 7, top: 1 }}><span className={k("mu")}>markdrop.in/</span>onboarding</span><span className={an(a, "d-new")} style={{ position: "absolute", left: 7, top: 1 }}><span className={k("mu")}>docs.example.com/</span>guides/onboarding</span></span>
        </div>
        <div style={{ display: "flex", height: 104 }}>
          <div style={{ width: 92, flex: "none", padding: "8px 7px", display: "flex", flexDirection: "column", gap: 4, background: "var(--surface-inset)", borderRight: "1px solid var(--border)", fontSize: 10, lineHeight: "14px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
            <span className={k("slot")} style={{ height: 14, fontWeight: 800, color: "var(--text)" }}><span className={an(a, "d-old")}>markdrop</span><span className={an(a, "d-new")}>Example Docs</span></span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="folder" size={10} />Guides</span>
            <span style={{ marginLeft: 12, padding: "0 5px", borderRadius: 4, background: "var(--surface-active)", color: "var(--text)", fontWeight: 600 }}>Onboarding</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="folder" size={10} />Policies</span>
          </div>
          <div style={{ flex: 1, minWidth: 0, position: "relative", padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <span className={an(a, "d-old")} style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: "var(--accent)" }} />
            <span className={an(a, "d-new")} style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: "var(--cat-builder)" }} />
            <span style={{ fontSize: 13, lineHeight: "16px", fontWeight: 800, color: "var(--text)" }}>Onboarding guide</span>
            <span className={k("sb")} style={{ width: "92%" }} /><span className={k("sb")} style={{ width: "74%" }} />
            <span style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4, marginTop: 2, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", fontSize: 9.5, color: "var(--text-muted)" }}><Icon name="lock" size={10} />Workspace only</span>
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 14, top: 162, display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1, color: "var(--text-muted)", whiteSpace: "nowrap" }}><span className={k("pc")}>docs.example.com</span>/<span className={k("pc")}>guides</span>/<span className={k("pc")}>onboarding</span><span style={{ marginLeft: 6, fontFamily: "var(--font-sans)" }}>folders are paths</span></div>
    </>
  );
}

function MBuilder({ a }: DioProps) {
  const blocks: Array<[number, string, string, string | null, boolean?]> = [
    [30, ".3s", "Title and badges", null], [60, ".45s", "Installation", "code"], [90, ".6s", "Architecture", "mermaid", true], [120, ".75s", "License", null],
  ];
  return (
    <>
      <div className={k("toy")} style={{ left: 12, top: 26, width: 140, height: 154 }}>
        <div className={k("t-hd")}><span style={{ display: "inline-flex", color: "var(--cat-builder)" }}><Icon name="builder" size={12} /></span>Sections</div>
        {blocks.map(([top, d, label, em, hl]) => (
          <div key={top} className={an(a, "blk")} style={v({ top, "--d": d, borderColor: hl ? "var(--cat-builder)" : undefined })}><span className={k("hd")}>⋮⋮</span>{label}{em && <em>{em}</em>}</div>
        ))}
      </div>
      <div className={k("toy")} style={{ left: 162, top: 26, width: 140, height: 154 }}>
        <div className={k("t-hd")}><Icon name="doc" size={12} />README.md</div>
        <div className={an(a, "rv")} style={v({ "--d": "1.2s", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 })}>
          <span style={{ fontSize: 12.5, lineHeight: "15px", fontWeight: 800, color: "var(--text)" }}>my-project</span>
          <span style={{ display: "flex", gap: 4 }}><span style={{ width: 30, height: 9, borderRadius: 3, background: "var(--success-soft)", border: "1px solid var(--success)" }} /><span style={{ width: 26, height: 9, borderRadius: 3, background: "var(--accent-soft)", border: "1px solid var(--accent-text)" }} /><span style={{ width: 22, height: 9, borderRadius: 3, background: "var(--surface-inset)", border: "1px solid var(--border-strong)" }} /></span>
          <span className={k("m10")} style={{ padding: "3px 6px", borderRadius: 4, background: "var(--code-bg)", border: "1px solid var(--code-border)", color: "var(--text)" }}>npm i my-project</span>
          <svg width="120" height="20" viewBox="0 0 120 20" aria-hidden="true">
            <rect x="1" y="2" width="34" height="16" rx="4" style={{ fill: "var(--surface-raised)", stroke: "var(--border-strong)" }} /><text x="18" y="13.5" textAnchor="middle" style={{ fill: "var(--text)", font: "600 8.5px var(--font-sans)" }}>Install</text>
            <path d="M37 10h7" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} />
            <rect x="44" y="2" width="34" height="16" rx="4" style={{ fill: "var(--surface-raised)", stroke: "var(--border-strong)" }} /><text x="61" y="13.5" textAnchor="middle" style={{ fill: "var(--text)", font: "600 8.5px var(--font-sans)" }}>Use</text>
            <path d="M80 10h7" style={{ stroke: "var(--text-muted)", strokeWidth: 1.5, fill: "none" }} />
            <rect x="85" y="2" width="34" height="16" rx="4" style={{ fill: "var(--accent-soft)", stroke: "var(--accent-text)" }} /><text x="102" y="13.5" textAnchor="middle" style={{ fill: "var(--accent-text)", font: "700 8.5px var(--font-sans)" }}>Ship</text>
          </svg>
          <span style={{ fontSize: 9.5, color: "var(--text-muted)" }}>Publish or export to PDF</span>
        </div>
      </div>
    </>
  );
}

/** One mobile screen pane, mounted per screen change (the key replays its one-shots). */
export function MobilePane({ screen, a, pd, send }: { screen: ScreenId; a: boolean; pd: string; send: { relay: boolean; d: string; path: string; route: "relay" | "direct" } }) {
  const isFile = screen === "html" || screen === "pdf" || screen === "xlsx" || screen === "mp4" || screen === "zip";
  let body: ReactNode;
  if (isFile) { const Body = PANE_BODY[screen as FileId]; body = <Body />; }
  else if (screen === "publish") body = <MPublish a={a} />;
  else if (screen === "encrypt") body = <MEncrypt a={a} />;
  else if (screen === "sync") body = <MSync a={a} />;
  else if (screen === "send") body = <MSend send={send} />;
  else if (screen === "domain") body = <MDomain a={a} />;
  else body = <MBuilder a={a} />;
  return (
    <div className={k("pane", a && "anim")} style={v({ "--pd": pd, ...(isFile ? PANE_STYLE[screen as FileId] : {}) })}>
      {body}
    </div>
  );
}
