import { Icon } from "@/components/ui";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES, type DocsTopic } from "@/lib/docsLinks";

/**
 * "Read more ↗": the docs page that explains a feature (DOCS_PAGES), in a new tab so whatever the
 * person was doing here stays put. Inline: sits at the end of a description or beside a heading.
 */
export function ReadMore({ topic, children = "Read more", className }: { topic: DocsTopic; children?: React.ReactNode; className?: string }) {
  return (
    <a
      href={docsUrl(DOCS_PAGES[topic])}
      target="_blank"
      rel="noopener"
      // Plain join, not cx: the ui barrel is client-only and this also renders in server components.
      className={`inline-flex items-center gap-0.5 whitespace-nowrap font-semibold text-accent-text underline-offset-2 hover:underline ${className ?? ""}`}
    >
      {children}
      <Icon name="arrowUpRight" size={13} />
      <span className="md-visually-hidden"> (opens the docs in a new tab)</span>
    </a>
  );
}

export default ReadMore;
