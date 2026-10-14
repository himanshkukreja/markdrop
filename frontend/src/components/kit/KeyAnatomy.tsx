/**
 * KeyAnatomy (K2 link & frames kit): the URL split at the `#` (REVAMP_PLAN 6.1 and the 8.2 sketch).
 *
 * `explain`: the path half sits over a "Markdrop's server" box with a ciphertext ribbon; the `#k=` half
 * (standard key treatment) sits over a "Your browser" box holding the key chip and "Stays in your
 * browser". `missing`: the fragment is a dashed empty `#k=` slot whose ring breathes 3× and rests
 * (static under reduced motion), with the callout "The key lives here. Browsers never send it to a
 * server, and this link arrived without it."
 *
 * Layouts: `full` (560×240 at 1440; boxes stack and connectors drop under a 520px container) and
 * `compact` (the URL line plus labels or the callout: the viewer's E2E card and the missing-key gate,
 * per Viewer / MobileReading boards). Server-compatible (no hooks); sizing uses container queries.
 */
import { KeyChip, normalizeFragment, parseLink } from "./LinkPill";
import { KitIcon } from "./DeviceGlyph";
import styles from "./KeyAnatomy.module.css";

export interface KeyAnatomyProps {
  /** host/slug, e.g. "markdrop.in/release-notes" (a protocol or fragment in it is ignored). */
  url: string;
  /** The key fragment to show in explain mode ("#k=Yx3fQ9vLm2…"); ignored in missing mode. */
  fragment?: string;
  mode?: "explain" | "missing";
  layout?: "full" | "compact";
  /** explain + full: the decrypted title for the "Decrypted here: …" line. Omit to hide the line. */
  decryptedTitle?: string;
  /** full: the footnote "Browsers never send the part after # …" (default true). */
  footnote?: boolean;
  className?: string;
}

/** Fixed illustrative ciphertext (deterministic, so SSR and hydration agree). */
const CIPHER = [
  "U2FsdGVkX19vQ2x0aGVtK8jR4mZq0pLwE3",
  "kq3VbW9yZXMtd2l0aG91dC1rZXkx9TnA",
  "9fJ2bGluay1pcy10aGUta2V5Lg7wRb1",
];

const CALLOUT = "The key lives here. Browsers never send it to a server, and this link arrived without it.";

function Path({ url }: { url: string }) {
  const p = parseLink(url);
  return (
    <>
      {p.host}
      {p.slug ? `/${p.slug}` : ""}
    </>
  );
}

/** The dashed empty `#k=` slot; `ring` adds the 3× breathing ring (one per figure). */
function MissingSlot({ size, ring = true, pointer }: { size: "sm" | "md" | "lg"; ring?: boolean; pointer?: boolean }) {
  return (
    <span className={styles.slotWrap} data-pointer={pointer || undefined}>
      {ring && <span className={styles.ring} aria-hidden="true" />}
      <KeyChip size={size} empty />
    </span>
  );
}

export function KeyAnatomy({ url, fragment, mode = "explain", layout = "full", decryptedTitle, footnote = true, className }: KeyAnatomyProps) {
  const missing = mode === "missing";
  const frag = normalizeFragment(fragment) || "#k=…";

  if (layout === "compact") {
    return (
      <div
        role="group"
        aria-label={missing ? "Where the key goes in a Markdrop link" : "What this link sends, and what stays in your browser"}
        className={[styles.compact, className ?? ""].join(" ")}
        data-mode={mode}
      >
        <div className={styles.cLine}>
          <span className={styles.cPath}>
            <Path url={url} />
          </span>
          {missing ? <MissingSlot size="sm" pointer /> : <KeyChip fragment={frag} size="sm" />}
        </div>
        {missing ? (
          <div className={styles.callout}>
            <p className={styles.calloutText}>{CALLOUT}</p>
          </div>
        ) : (
          <div className={styles.cLabels}>
            <span className={styles.cSent}>Sent to the server</span>
            <span className={styles.cStays}>Stays in your browser</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <figure
      className={[styles.full, className ?? ""].join(" ")}
      data-mode={mode}
      aria-label={
        missing
          ? "Key anatomy: the path goes to Markdrop's server; the key after the hash is missing from this link"
          : "Key anatomy: the path goes to Markdrop's server, the fragment after the hash stays in your browser"
      }
    >
      <div className={styles.grid}>
        {/* Row 1: what each half is */}
        <div className={`${styles.cap} ${styles.capPath}`}>The path · sent to the server</div>
        <div className={`${styles.cap} ${styles.capFrag}`}>{missing ? "The fragment · missing" : "The fragment · never sent"}</div>

        {/* Row 2: the URL split at the # */}
        <div className={styles.urlPath}>
          <span className={styles.urlPathText}>
            <Path url={url} />
          </span>
        </div>
        <div className={styles.urlFrag} data-missing={missing || undefined}>
          {missing ? (
            <span className={styles.urlFragText}>
              <KitIcon name="key" size={18} />
              <span>#k=</span>
              <span className={styles.hole} aria-hidden="true" />
              <span className="md-visually-hidden">(missing)</span>
            </span>
          ) : (
            <span className={styles.urlFragText}>
              <KitIcon name="key" size={18} />
              <span className={styles.ellipsis}>{frag}</span>
            </span>
          )}
        </div>

        {/* Row 3: connectors (dropped when stacked) */}
        <div className={styles.conn} aria-hidden="true">
          <span />
        </div>
        <div className={`${styles.conn} ${styles.connFrag}`} aria-hidden="true">
          <span />
        </div>

        {/* Row 4: where each half goes */}
        <div className={`${styles.box} ${styles.server}`}>
          <div className={styles.boxHead}>
            <KitIcon name="server" size={20} className={styles.serverIcon} />
            <span className={styles.boxTitle}>Markdrop&apos;s server</span>
          </div>
          <p className={styles.boxCaption}>Gets the path. Stores what it can&apos;t read.</p>
          <div className={styles.ribbon}>
            <span className="md-visually-hidden">Ciphertext</span>
            {CIPHER.map((c) => (
              <span key={c} aria-hidden="true" className={styles.ribbonLine}>
                {c}
              </span>
            ))}
          </div>
          <span className={styles.micro}>Title and text, as ciphertext</span>
        </div>

        <div className={`${styles.box} ${styles.browser}`}>
          <div className={styles.boxHead}>
            <KitIcon name="monitor" size={20} className={styles.browserIcon} />
            <span className={styles.boxTitle}>Your browser</span>
          </div>
          <p className={styles.boxCaption}>{missing ? "Needs the key to decrypt the page." : "Holds the key and decrypts the page."}</p>
          {missing ? (
            <div className={styles.missingBlock}>
              <MissingSlot size="md" pointer />
              <div className={styles.callout}>
                    <p className={styles.calloutText}>{CALLOUT}</p>
              </div>
            </div>
          ) : (
            <div className={styles.keyBlock}>
              <KeyChip fragment={frag} size="md" />
              <span className={styles.micro}>Stays in your browser</span>
            </div>
          )}
          {!missing && decryptedTitle && (
            <div className={styles.decrypted}>
              <KitIcon name="checkCircle" size={14} className={styles.ok} />
              <span>
                Decrypted here: <strong>{decryptedTitle}</strong>
              </span>
            </div>
          )}
        </div>
      </div>

      {footnote && (
        <figcaption className={styles.foot}>
          <KitIcon name="eyeOff" size={16} />
          <span>
            Browsers never send the part after <code className={styles.hash}>#</code> to any server, so the key never reaches Markdrop.
          </span>
        </figcaption>
      )}
    </figure>
  );
}

export default KeyAnatomy;
