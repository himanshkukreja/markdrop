"use client";

import { Icon, Tooltip } from "@/components/ui";
import { CATEGORY_LABEL, type JiraIssue, type JiraLink } from "@/lib/jira";
import "./jira.css";

/** An issue's status as a small pill: To do / In progress / Done colours by Jira's status category. */
export function JiraStatus({ issue }: { issue: JiraIssue }) {
  const cat = issue.status.category;
  return (
    <span className={`jr-status jr-status--${cat}${issue.blocked && cat !== "done" ? " jr-status--blocked" : ""}`} title={CATEGORY_LABEL[cat]}>
      {issue.status.name || CATEGORY_LABEL[cat]}
    </span>
  );
}

/**
 * A live Jira chip: key · status · assignee, linking to the issue. Without `issue` (the viewer's own
 * Jira can't open it, or they aren't connected) just the key. A sync problem shows a warning with Retry.
 */
export function JiraChip({ link, issue, url, onRetry, compact }: {
  link?: JiraLink | null; issue?: JiraIssue | null; url?: string | null; onRetry?: (() => void) | null; compact?: boolean;
}) {
  const it = issue ?? link?.issue ?? null;
  const key = it?.key ?? link?.key ?? "";
  const href = it?.url ?? url ?? link?.url ?? null;
  const sync = link?.sync;
  const label = it ? `${key}: ${it.summary ?? ""} (${it.status.name}${it.assignee ? `, ${it.assignee.name}` : ""})` : `Jira issue ${key}`;
  return (
    <span className={`jr-chip not-prose${compact ? " jr-chip--compact" : ""}`} data-testid="jira-chip" data-key={key}>
      <a className="jr-chip__main md-focus" href={href || undefined} target="_blank" rel="noreferrer" aria-label={label}
        onClick={(e) => e.stopPropagation()}>
        <span className="jr-chip__key">{key}</span>
        {it && <JiraStatus issue={it} />}
        {it?.assignee && !compact && <span className="jr-chip__who">{it.assignee.name}</span>}
        {it?.overdue && <span className="jr-chip__late">overdue</span>}
      </a>
      {sync && sync.state !== "ok" && (
        <Tooltip content={sync.message || "Not in step with Jira."}>
          <span className={`jr-chip__sync jr-chip__sync--${sync.state}`} tabIndex={0} data-testid="jira-chip-sync">
            <Icon name={sync.state === "pending" ? "clock" : "alert"} />
            {onRetry && sync.state === "error" && (
              <button type="button" className="jr-chip__retry" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRetry(); }}>Retry</button>
            )}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/** One issue as a row (Team, a person's page): chip, summary, due (not in `dense` rows: a Team card). */
export function JiraIssueRow({ issue, dense }: { issue: JiraIssue; dense?: boolean }) {
  return (
    <li className="jr-row" data-testid="jira-issue-row">
      <JiraChip issue={issue} compact />
      <span className="jr-row__summary">{issue.summary}</span>
      {issue.due && !dense && <span className={`jr-row__due${issue.overdue ? " jr-row__due--late" : ""}`}>{issue.overdue ? "Overdue · " : "Due "}{issue.due}</span>}
    </li>
  );
}
