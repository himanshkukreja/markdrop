/**
 * The page title block for app pages (dashboard, settings, workspaces; REVAMP_PLAN 8.2): optional
 * breadcrumb, eyebrow, the page's single h1, a one-line description and the page actions (the
 * page's own primary goes here). Wraps on phones: actions drop under the title. Server-safe (no
 * hooks); pass client components as `actions`/`breadcrumb`/`leading`.
 */
export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  /** e.g. <Breadcrumb items=… /> from "@/components/ui". */
  breadcrumb?: React.ReactNode;
  /** Right-aligned controls (one primary at most). */
  actions?: React.ReactNode;
  /** Before the title (e.g. a brand tile). */
  leading?: React.ReactNode;
  /** id for the h1 (aria-labelledby targets). */
  titleId?: string;
  className?: string;
}

export function PageHeader({ title, description, eyebrow, breadcrumb, actions, leading, titleId, className }: PageHeaderProps) {
  return (
    <header className={`flex min-w-0 flex-col gap-3 ${className ?? ""}`}>
      {breadcrumb}
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {leading}
          <div className="flex min-w-0 flex-col gap-1">
            {eyebrow && <p className="text-eyebrow uppercase text-text-muted">{eyebrow}</p>}
            <h1 id={titleId} className="text-h1 text-text [overflow-wrap:anywhere]" dir="auto">{title}</h1>
            {description && <p className="text-body text-text-secondary">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export default PageHeader;
