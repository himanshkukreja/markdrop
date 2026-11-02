import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import s from "./snap.module.css";

/**
 * The one-viewport, snap-scrolling frame of the marketing pages (/, /guides, /mcp, /enterprise).
 *
 *   <SnapPage>                     the page's root: the size variables (--snap-h, --snap-usable…),
 *     <SnapSection id … >          and, from 1024 × 640, `scroll-snap-type: y mandatory` on <html>
 *     <SnapSection id … >          (scoped with :has, so no other page is touched). Each section is
 *   </SnapPage>                    one viewport under the header and snaps to its start; the footer
 *                                  snaps to the page's end. Phones scroll normally.
 *
 * A section that can't fit one viewport stays a taller block that snaps at its start; mark the
 * start of its second screen with `data-snap-point=""` to add a stop there.
 *
 * Server components (no script). See snap.module.css for the rules.
 */

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

export function SnapPage({ className, children, ...rest }: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cx(s.page, className)} {...rest}>
      {children}
    </div>
  );
}

type SectionProps = Omit<ComponentPropsWithoutRef<"section">, "id"> & {
  /** The section's anchor (and the snap point a link to it lands on). */
  id: string;
  /** The id of its heading (aria-labelledby). */
  labelledBy?: string;
  /** Skip the shared box (width, one-viewport height, centring): the section draws its own. */
  bare?: boolean;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
};

/** One snap point: a <section data-snap-section>, one viewport tall from 900px wide. */
export function SnapSection({ id, labelledBy, bare, className, children, ref, ...rest }: SectionProps) {
  return (
    <section ref={ref} id={id} aria-labelledby={labelledBy} data-snap-section="" className={cx(!bare && s.section, className)} {...rest}>
      {children}
    </section>
  );
}
