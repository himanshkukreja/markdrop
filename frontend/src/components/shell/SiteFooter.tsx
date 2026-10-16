import { Anchor, Icon, MarkdropLogo, VisuallyHidden } from "@/components/ui";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import PrivacyChoicesButton from "@/components/analytics/PrivacyChoicesButton";
import { FOOTER_COLUMNS } from "./links";

/**
 * The marketing footer (REVAMP_PLAN 7.1, Landing board): Brand (logo, one-liner, theme
 * SegmentedControl) · Product · Teams · Developers, then "© Markdrop · MIT licensed". Four columns
 * from 1024px; a 2×2 grid below that. A server component: the theme
 * control is the only client island. Real URLs only, never #anchors.
 */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={`no-print w-full border-t border-border bg-bg ${className ?? ""}`}>
      <div className="mx-auto w-full max-w-marketing px-4 pt-12 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:px-6 lg:pt-14">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]">
          <div className="flex min-w-0 flex-col items-start gap-4">
            <MarkdropLogo size={28} />
            <p className="max-w-[18rem] text-body text-text-secondary">Docs and files as links that render</p>
            {/* Labels from 640px; icons (each still named) in the phone's narrow column. */}
            <ThemeSegmented size="sm" label="Theme" className="hidden sm:inline-flex" />
            <ThemeSegmented size="sm" label="Theme" iconOnly className="sm:hidden" />
          </div>
          {FOOTER_COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title} className="flex min-w-0 flex-col gap-3">
              <h2 className="text-eyebrow uppercase text-text-muted">{col.title}</h2>
              <ul className="flex flex-col gap-1">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Anchor
                      href={l.href}
                      {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="md-focus inline-flex min-h-11 items-center gap-1 rounded-sm text-body text-text-secondary no-underline hover:text-text lg:min-h-8"
                    >
                      {l.label}
                      {l.external && (
                        <>
                          <Icon name="external" size={13} className="text-text-muted" />
                          <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
                        </>
                      )}
                    </Anchor>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-caption text-text-muted">
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>© Markdrop · MIT licensed</span>
            <Anchor href="/privacy" className="md-focus inline-flex min-h-6 items-center rounded-sm text-text-muted no-underline hover:text-text">
              Privacy
            </Anchor>
            <PrivacyChoicesButton className="md-focus inline-flex min-h-6 cursor-pointer items-center rounded-sm text-text-muted hover:text-text" />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="globe" size={14} />
            markdrop.in
          </span>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
