"use client";

import { Alert, Button, Dialog, EmptyState, RadioGroup, Textarea } from "@/components/ui";

const CATEGORIES = ["Spam", "Phishing or malware", "Abuse or harassment", "Something else"];

/**
 * Report (REVAMP_PLAN 7.6 "Dialogs"): neutral, never danger — reporting destroys nothing. The
 * category is prefixed into the existing free-text `reason`, so the API is unchanged.
 */
export function ReportDialog({
  open, onClose, done, busy, error, category, onCategory, reason, onReason, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  done: boolean;
  busy: boolean;
  error: string;
  category: string;
  onCategory: (v: string) => void;
  reason: string;
  onReason: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={done ? "Report sent" : "Report this document"}
      description={done ? undefined : "Tell us what's wrong. Our team reviews every report."}
      dismissible={!busy}
      footer={
        done ? (
          <Button variant="secondary" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={onSubmit} loading={busy}>Send report</Button>
          </>
        )
      }
    >
      {done ? (
        <EmptyState icon="checkCircle" title="Report sent" description="Thanks — our team will review this document." />
      ) : (
        <div className="flex flex-col gap-4">
          <RadioGroup
            name="md-report-category"
            aria-label="What's wrong"
            value={category}
            onChange={onCategory}
            options={CATEGORIES.map((c) => ({ value: c, label: c }))}
          />
          <Textarea
            aria-label="Details (optional)"
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Details (optional)"
          />
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}
