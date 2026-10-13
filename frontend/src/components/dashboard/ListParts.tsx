"use client";

import { Button, DocumentRowSkeleton, Pagination } from "@/components/ui";

/** Five skeleton rows that mirror DocumentRow (REVAMP_PLAN 7.10 "Loading"). */
export function ListSkeleton({ rows = 5, label = "Loading documents" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="flex flex-col gap-2">
      <span className="md-visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <DocumentRowSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * "Showing 20 of 143" + Pagination wired to the API's `pages`. On phones the pager becomes
 * "Previous / Next" with "Page 2 of 8".
 */
export function ListFooter({
  page, pages, shown, total, perPage, onPage, phone,
}: {
  page: number;
  pages: number;
  shown: number;
  total: number;
  perPage: number;
  onPage: (p: number) => void;
  phone: boolean;
}) {
  if (total <= 0) return null;
  const from = (page - 1) * perPage + 1;
  const to = from + shown - 1;
  const caption = pages > 1
    ? `Showing ${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`
    : `Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;

  if (phone) {
    return (
      <div className="flex flex-col items-center gap-3 pt-2">
        <p className="text-caption text-text-muted">{caption}</p>
        {pages > 1 && (
          <nav aria-label="Pagination" className="flex w-full items-center justify-between gap-3">
            <Button variant="secondary" iconLeft="chevronLeft" className="h-11" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
            <span className="text-caption text-text-secondary" aria-current="page">Page {page} of {pages}</span>
            <Button variant="secondary" iconRight="chevronRight" className="h-11" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <p className="text-caption text-text-muted">{caption}</p>
      {pages > 1 && <Pagination page={page} pageCount={pages} onChange={onPage} />}
    </div>
  );
}
