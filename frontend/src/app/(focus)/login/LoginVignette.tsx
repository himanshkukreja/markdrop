"use client";

import { DocumentRow, Icon, VSCodeIcon } from "@/components/ui";

/**
 * The /login right-hand column (Auth.dc.html panel 1): three sample document rows, styled as the
 * real product UI, then what signing in adds. The rows are an illustration, not links: none of the
 * sample slugs is published (REVAMP_BUILD H.8: a chip links only when its slug is published), so
 * the group is `inert` (no tab stops, no clicks) and read as one image with a text alternative.
 * No view counts (cut: it read as a stats claim).
 */
const SAMPLE_DOCS = [
  { title: "Q3 roadmap", slug: "q3-roadmap" },
  { title: "Release notes", slug: "release-notes" },
  { title: "Onboarding guide", slug: "onboarding" },
] as const;

const BENEFITS: Array<{ text: string; icon: string | null; tint: string }> = [
  { text: "Upload files that render, all in one place", icon: "folder", tint: "text-cat-document" },
  { text: "See who reads what you publish", icon: "eye", tint: "text-accent-text" },
  { text: "Sync markdown from VS Code", icon: null, tint: "text-cat-sync" },
  { text: "Share inside a team workspace", icon: "users", tint: "text-cat-share" },
];

export function Benefits({ className, bare }: { className?: string; bare?: boolean }) {
  return (
    <div className={[bare ? "" : "rounded-xl border border-border bg-surface p-4", className].filter(Boolean).join(" ")}>
      {!bare && <h2 className="m-0 mb-2 text-eyebrow uppercase text-text-muted">Your documents, in one place</h2>}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {BENEFITS.map((b) => (
          <li key={b.text} className="flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5">
            <span className={`grid size-[26px] flex-none place-items-center rounded-md border border-border bg-surface-raised ${b.tint}`} aria-hidden="true">
              {b.icon ? <Icon name={b.icon} size={14} /> : <VSCodeIcon size={14} />}
            </span>
            <span className="min-w-0 text-body text-text-secondary">{b.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LoginVignette({ className }: { className?: string }) {
  return (
    <aside
      aria-label="What signing in adds"
      className={["relative min-w-0 flex-col gap-4 overflow-hidden border-l border-border bg-surface-inset p-6", className].filter(Boolean).join(" ")}
      style={{ backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
    >
      <h2 className="m-0 text-eyebrow uppercase text-text-muted">Your documents</h2>
      <div
        role="img"
        aria-label="Example of your documents list: Q3 roadmap, Release notes and Onboarding guide, each a markdrop.in link."
        className="flex flex-col gap-2"
      >
        <div inert className="flex flex-col gap-2">
          {SAMPLE_DOCS.map((d) => (
            <div key={d.slug} className="rounded-xl shadow-(--shadow-md)">
              <DocumentRow
                title={d.title}
                meta={<span className="font-mono">markdrop.in/{d.slug}</span>}
                href="#"
                icon="doc"
              />
            </div>
          ))}
        </div>
      </div>
      <Benefits bare className="mt-1" />
    </aside>
  );
}
