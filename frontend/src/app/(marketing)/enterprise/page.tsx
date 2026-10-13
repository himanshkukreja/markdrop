import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Alert, Avatar, Badge, Button, Card, Input, MarkdropMark, Select, Switch, AccessGate } from "@/components/ui";
import { ThemeScope } from "@/components/ui/scope";
import { KitIcon } from "@/components/kit/DeviceGlyph";
import { HeroSwap, SWAP_SCRIPT } from "./HeroSwap";
import { DnsPanel } from "./DnsPanel";
import { WorkspaceCta } from "./WorkspaceCta";
import s from "./enterprise.module.css";

export const metadata: Metadata = {
  title: "Custom domains & white-labelling — Markdrop",
  description:
    "Serve your docs and files from your own domain with your own branding. Custom domains, white-label preview cards, view-only CDN mode, folders and team roles.",
  // Override the site-wide card from the root layout so this page previews as itself.
  openGraph: {
    title: "Custom domains & white-labelling — Markdrop",
    description: "Serve your docs and files from your own domain with your own branding.",
  },
  twitter: {
    card: "summary",
    title: "Custom domains & white-labelling — Markdrop",
    description: "Serve your docs and files from your own domain with your own branding.",
  },
};

/** D17: a markdrop.in address, shown as text. This one is the live reply-to of every Markdrop email
 *  (backend config `email_reply_to`). Pending the owner's pick of a dedicated address (Q4). */
const CONTACT = "himanshu@markdrop.in";
const CONTACT_HREF = `mailto:${CONTACT}?subject=${encodeURIComponent("Markdrop for our team")}`;

const CONTAINER = "mx-auto w-full max-w-marketing px-4 sm:px-6";
const SECTION = "py-16 md:py-24";

const HERO_POINTS = [
  "Your hostname, with a certificate we issue",
  "Your name and favicon in every tab",
  "Your colour across every page",
  "Your brand on link previews",
];

const STEPS = [
  { t: "Add your domain", d: "Any hostname you control. A subdomain such as docs. is simplest." },
  { t: "Paste two DNS records", d: "One proves it is yours, one points it here." },
  { t: "We issue the certificate", d: "Once both records resolve, your documents are live on it." },
];

const ROLES = [
  { name: "Owner", pips: 4, d: "Everything an admin can do, plus deleting the workspace." },
  { name: "Admin", pips: 3, d: "Manages members, domains and branding." },
  { name: "Member", pips: 2, d: "Creates and publishes documents." },
  { name: "Viewer", pips: 1, d: "Reads what the workspace publishes." },
];

const TREE = [
  { label: "Library", icon: "inbox", count: "48", nested: false },
  { label: "handbook", icon: "folder", count: "12", nested: false },
  { label: "engineering", icon: "folder", count: "21", nested: false },
  { label: "specs", icon: "folder", count: "9", nested: true },
  { label: "runbooks", icon: "folder", count: "7", nested: true },
  { label: "changelog", icon: "folder", count: "8", nested: false },
];

const WS_TABS = [
  { label: "General" },
  { label: "Brand" },
  { label: "Domains", count: 1 },
  { label: "People", count: 4, on: true },
  { label: "Folders" },
];

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

const MEMBERS = [
  { name: "Priya Shah", email: "priya@example.com", kind: "owner" as const },
  { name: "Daniel Okafor", email: "daniel@example.com", kind: "member" as const, role: "admin" },
  { name: "Mei Lin", email: "mei@example.com", kind: "member" as const, role: "member" },
  { name: "Sara Nilsson", email: "sara@example.com", kind: "member" as const, role: "viewer" },
  { name: "Jordan Reyes", email: "jordan@example.com · invited", kind: "invite" as const },
];

const LEVELS = [
  { id: "private", icon: "lock", t: "Private", d: "Only you and the people you add" },
  { id: "link", icon: "link", t: "Link", d: "Anyone with the link can read" },
  { id: "workspace", icon: "user", t: "Workspace", d: "Every member of Acme Docs", on: true },
];

const GRANTS = [
  { name: "Priya Shah", email: "priya@example.com", owner: true },
  { name: "Marco Bianchi", email: "marco@partner.example.com", role: "viewer" },
  { name: "Lena Fischer", email: "lena@example.com", role: "editor" },
];

/** Copy verbatim from the previous /enterprise page (REVAMP_PLAN 7.2 §3). */
const FEATURES = [
  { icon: "globe", t: "No Markdrop anywhere", d: "Your name, favicon and colour on every page and link preview." },
  { icon: "eye", t: "View-only mode", d: "Hide every control for visitors. A plain page, served like a CDN." },
  { icon: "lock", t: "Only your documents", d: "A slug from elsewhere on Markdrop returns 404 on your host." },
  { icon: "folder", t: "Folders & roles", d: "Owner, admin, member, viewer. Folders file; they never grant access." },
  { icon: "users", t: "Require sign-in", d: "Refuse anonymous reads — on every link, not just your domain." },
  { icon: "key", t: "End-to-end encryption", d: "Sealed in the browser. The key rides in the link, never our servers." },
];

const CAN_SEE = [
  { t: "Documents shared into the workspace", d: "Their titles appear in the library, filed by folder." },
  { t: "Who belongs, and each person’s role", d: "Members, pending invitations and the invitation history." },
  { t: "The domains, branding and folders", d: "Everything on the workspace settings page." },
];

const NEVER_SEE = [
  { t: "A member’s own documents", d: "A document joins the workspace only when its owner shares it in." },
  { t: "The text of an encrypted document", d: "Markdrop stores ciphertext it has no key for. Signing in never unlocks it." },
  { t: "Anyone else’s ownership", d: "Documents never change owner. Delete the workspace and they go back to their owners, with the same links and analytics." },
];

const CAVEATS = [
  { t: "One job per host.", d: "Documents or uploaded files, never both. That separation keeps uploaded content away from your session." },
  { t: "Subdomains are simplest.", d: "An apex domain needs an A record, which not every DNS provider handles well." },
  { t: "View-only hides Report.", d: "So it applies only on domains you own and answer for, never on markdrop.in." },
];

/* ── Small server pieces ────────────────────────────────────────────────── */

function SectionHead({ eyebrow, title, id, lead, eyebrowClass = "text-text-muted" }: {
  eyebrow: string; title: ReactNode; id: string; lead?: ReactNode; eyebrowClass?: string;
}) {
  return (
    <div className="min-w-0">
      <p className={`text-eyebrow uppercase ${eyebrowClass}`}>{eyebrow}</p>
      <h2 id={id} className="mt-2.5 text-[32px] leading-9 font-extrabold tracking-[-0.025em] text-balance md:mt-3 md:text-display">
        {title}
      </h2>
      {lead && <p className="mt-3 max-w-[60ch] text-body-lg text-text-secondary md:text-lg md:leading-7">{lead}</p>}
    </div>
  );
}

/** A product screen drawn as an illustration: one image to assistive tech, never a tab stop. */
function Illustration({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="img" aria-label={label} className={className}>
      <div inert className="contents">{children}</div>
    </div>
  );
}

function ContactLine({ className = "" }: { className?: string }) {
  return (
    <p className={`text-caption text-text-muted ${className}`}>
      Or write to{" "}
      <a href={CONTACT_HREF} className="rounded-sm bg-code-inline-bg px-1.5 py-0.5 font-mono text-text-secondary underline-offset-2 hover:underline">
        {CONTACT}
      </a>
    </p>
  );
}

function Ctas({ center = false }: { center?: boolean }) {
  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:flex-wrap ${center ? "sm:justify-center" : ""}`}>
      <WorkspaceCta className="max-sm:w-full" />
      <Button variant="secondary" size="lg" href={CONTACT_HREF} className="max-sm:w-full">
        Talk to us
      </Button>
    </div>
  );
}

function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono ${className}`}>{children}</span>;
}

/* ── Sections ───────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section aria-labelledby="ent-title" className={`${s.hero} pt-10 pb-16 md:pt-16 md:pb-20`}>
      <div className={s.heroFx} aria-hidden="true">
        <div className={s.heroDots} />
        <div className={s.heroGlow} />
      </div>
      {/* Runs before the figure paints: a returning visitor never sees the start frame. */}
      <script dangerouslySetInnerHTML={{ __html: SWAP_SCRIPT }} />
      <div className={`${CONTAINER} ${s.heroGrid}`}>
        <div className={s.heroCopy}>
          <p className="text-eyebrow text-text-muted uppercase">For teams</p>
          <h1 id="ent-title" className={s.h1}>
            Your domain.
            <br />
            Your brand.
          </h1>
          <p className="mt-5 max-w-[440px] text-body-lg text-text-secondary md:text-lg md:leading-7">
            Publish from your own domain, under your own name. Nobody sees Markdrop.
          </p>
          <div className="mt-8">
            <Ctas />
          </div>
          <ContactLine className="mt-3 text-center sm:text-left" />
        </div>

        <div className={s.heroVisual}>
          <HeroSwap />
        </div>

        <ol className={`${s.heroPoints} m-0 flex list-none flex-col gap-3 p-0 lg:gap-2.5`}>
          {HERO_POINTS.map((p, i) => (
            <li key={p} className="flex items-center gap-3">
              <span aria-hidden="true" className={s.pin}>{i + 1}</span>
              <span className="text-body-lg text-text-secondary lg:text-body">{p}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Domains() {
  return (
    <section id="domains" aria-labelledby="domains-title" className="pb-16 md:pb-24">
      <div className={`${CONTAINER} grid gap-10 xl:grid-cols-[440px_minmax(0,1fr)] xl:gap-18`}>
        <div className="min-w-0">
          <SectionHead
            eyebrow="Custom domains"
            id="domains-title"
            title="Three steps to your domain"
            lead="Add a hostname you control, paste two records into your DNS, and we take it from there."
          />
          <div className={`${s.steps} mt-8`}>
            <span aria-hidden="true" className={s.stepsLine} />
            <ol className="relative m-0 flex list-none flex-col gap-5 p-0">
              {STEPS.map((st, i) => (
                <li key={st.t} className="relative flex gap-4">
                  <span aria-hidden="true" className={s.stepNum}>{i + 1}</span>
                  <div className="min-w-0">
                    <div className="text-body-strong leading-8">{st.t}</div>
                    <div className="text-body text-text-secondary">{st.d}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="min-w-0 xl:pt-2">
          <DnsPanel />
        </div>
      </div>
    </section>
  );
}

function BrandCard() {
  return (
    <Illustration
      label="Brand settings for Acme Docs: site name, accent colour, favicon, logo and white-label preview cards"
      className={`${s.panel} flex min-w-0 flex-col`}
    >
      <div className="flex min-h-14 items-center gap-2.5 border-b border-border px-4 md:min-h-15 md:px-5">
        <span className="text-h4">Brand</span>
        <span className="text-caption text-text-muted">Acme Docs · Settings</span>
      </div>
      <div className="grid gap-5 p-4 sm:grid-cols-2 md:p-5">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-body-strong">Site name</span>
            <Input defaultValue="Acme Docs" readOnly aria-label="Site name" />
            <span className="text-caption text-text-muted">Replaces “Markdrop” in titles and cards.</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-body-strong">
              Accent colour <span className="text-caption font-medium text-accent-text">Reset</span>
            </span>
            <span className="flex gap-2">
              <span className={s.swatch} />
              {/* The sample tenant's accent value (the documented demo-accent exception). */}
              <span className={`${s.fakeField} flex-1 font-mono`}>#e60076</span>
            </span>
          </div>
          <Switch defaultChecked readOnly label="White-label preview cards" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-body-strong">Favicon</span>
          <div className={s.drop}>
            <span className={`${s.dropThumb} w-12`}>
              <span className={`${s.tenantMark} size-10 text-xl`}>A</span>
            </span>
            <div className={s.dropText}>
              <div className="text-body text-text">Drop a new image to replace</div>
              <div className="text-caption text-text-muted">Square PNG or JPG, 128px or larger.</div>
            </div>
            <span className="text-caption font-medium text-text-secondary">Remove</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
          <span className="text-body-strong">Logo</span>
          <div className={s.drop}>
            <span className={`${s.dropThumb} gap-2 px-3`}>
              <span className={`${s.tenantMark} size-6 text-[13px]`}>A</span>
              <span className={s.logoWord}>Acme Docs</span>
            </span>
            <div className={s.dropText}>
              <div className="text-body text-text">Drop a new image to replace</div>
              <div className="text-caption text-text-muted">Wide PNG or JPG. Shown in the header.</div>
            </div>
            <span className="text-caption font-medium text-text-secondary">Remove</span>
          </div>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border bg-surface-inset px-4 py-3 md:px-5">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        <span className="flex-1 text-caption text-text-secondary">You have unsaved changes</span>
        <span className="flex gap-2 max-sm:w-full">
          <Button variant="ghost" size="sm" className="max-sm:flex-1">Discard</Button>
          <Button size="sm" className="max-sm:flex-1">Save changes</Button>
        </span>
      </div>
    </Illustration>
  );
}

function LinksLook() {
  return (
    <Illustration
      label="How Acme Docs links look: a browser tab with the Acme Docs favicon and name, and a link preview card with the Acme Docs name and accent on docs.example.com"
      className={`${s.panel} flex min-w-0 flex-col`}
    >
      <div className="flex min-h-14 items-center gap-2.5 border-b border-border px-4 md:min-h-15 md:px-5">
        <span className="text-h4">How your links look</span>
      </div>
      <div className="flex flex-col gap-4 p-4 md:p-5">
        <div>
          <div className="mb-2 text-eyebrow text-text-muted uppercase">Browser tab</div>
          <div className="flex items-end gap-1 overflow-hidden rounded-lg border border-border bg-surface-inset px-2.5 pt-2">
            <span className="inline-flex h-8 flex-none items-center gap-2 rounded-t-md border border-b-0 border-border bg-surface px-3">
              <span className={s.favicon}>A</span>
              <span className="text-caption whitespace-nowrap">Onboarding guide · Acme Docs</span>
            </span>
            <span className="inline-flex h-8 flex-none items-center gap-2 px-3 text-text-muted">
              <span className={`${s.favicon} opacity-60`}>A</span>
              <span className="text-caption whitespace-nowrap">Q3 roadmap · Acme Docs</span>
            </span>
          </div>
        </div>
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-eyebrow text-text-muted uppercase">Link preview card</span>
            <span className="text-caption text-text-muted">Cards are always dark, whatever the app.</span>
          </div>
          <ThemeScope theme="dark" bare className="rounded-lg">
            <div className={s.ogCard}>
              <span className={s.ogName}>Acme Docs</span>
              <div>
                <div className="text-h2 text-text">Onboarding guide</div>
                <div className="mt-1 text-body text-text-secondary">Your accounts, tools and first week.</div>
              </div>
              <Mono className="text-caption text-text-secondary">docs.example.com</Mono>
            </div>
          </ThemeScope>
        </div>
      </div>
    </Illustration>
  );
}

function WhiteLabel() {
  return (
    <section id="white-label" aria-labelledby="wl-title" className={`${SECTION} border-y border-border bg-surface-inset`}>
      <div className={CONTAINER}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <SectionHead
            eyebrow="White-label"
            eyebrowClass="text-text-secondary"
            id="wl-title"
            title="Nobody sees Markdrop."
            lead="Your site name, favicon, logo and colour on every page and every link preview."
          />
          <p className="flex max-w-[44ch] gap-2 text-caption text-text-secondary lg:items-center">
            <span className="inline-flex flex-none pt-0.5 lg:pt-0"><KitIcon name="eyeOff" size={14} /></span>
            View-only mode hides the reader controls from signed-out visitors, on your own domain only.
          </p>
        </div>
        <div className="mt-8 grid items-start gap-4 md:gap-8 lg:grid-cols-2">
          <BrandCard />
          <LinksLook />
        </div>
      </div>
    </section>
  );
}

function WorkspaceMock() {
  return (
    <Illustration
      label="The People tab of the Acme Docs workspace settings: an owner, an admin, a member, a viewer and a pending invitation that expires in 5 days"
      className={`${s.panel} grid min-w-0 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-1 xl:grid-cols-[220px_minmax(0,1fr)]`}
    >
      <div className="hidden flex-col gap-1 border-r border-border bg-bg px-3 py-4 md:flex lg:hidden xl:flex">
        <div className="flex items-center gap-2.5 px-2 pt-1 pb-3">
          <span className={`${s.tenantMark} size-6 text-xs`}>A</span>
          <span className="text-body-strong">Acme Docs</span>
        </div>
        {TREE.map((f) => (
          <div key={f.label} className={`flex h-8 items-center gap-2 rounded-md pr-2 text-text-secondary ${f.nested ? "pl-7" : "pl-2"}`}>
            <KitIcon name={f.icon} size={14} />
            <span className="flex-1 text-body">{f.label}</span>
            <span className="text-micro text-text-muted">{f.count}</span>
          </div>
        ))}
        <div className="flex h-8 items-center gap-2 rounded-md bg-accent-soft px-2 font-semibold text-accent-text">
          <KitIcon name="settings" size={14} />
          <span className="flex-1 text-body">Settings</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-3 px-3 pt-3 pb-2 md:px-5 md:pt-4">
          <span className="inline-flex size-11 flex-none items-center justify-center rounded-lg border border-border text-text-secondary md:hidden lg:inline-flex xl:hidden">
            <KitIcon name="folder" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-caption text-text-muted">Acme Docs › Settings</div>
            <div className="text-h3">People</div>
          </div>
          <Button variant="secondary" size="sm" iconLeft="plus">
            <span className="md:hidden">Invite</span>
            <span className="hidden md:inline">Invite people</span>
          </Button>
        </div>
        <div className="flex overflow-hidden border-b border-border px-1 md:px-3">
          {WS_TABS.map((t) => (
            <span key={t.label} className={`${s.tab} ${t.on ? s.tabOn : ""} ${t.label === "Folders" ? s.tabWide : ""}`}>
              {t.label}
              {t.count != null && <span className="rounded-full bg-surface-inset px-1.5 text-micro text-text-muted">{t.count}</span>}
            </span>
          ))}
        </div>
        <div className="px-3 md:px-5">
          {MEMBERS.map((m) => (
            <div key={m.name} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_28px] items-center gap-3 border-b border-border py-2 md:min-h-12 md:grid-cols-[minmax(0,1fr)_150px_32px]">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name={m.name} size="sm" neutral={m.kind === "invite"} />
                <div className="min-w-0">
                  <div className="truncate text-body-strong leading-[18px]">{m.name}</div>
                  <div className="truncate text-caption text-text-muted">{m.email}</div>
                </div>
              </div>
              <div className="flex justify-end md:justify-start">
                {m.kind === "owner" && <Badge tone="info" size="sm">Owner</Badge>}
                {m.kind === "member" && (
                  <div className="w-28 md:w-full">
                    <Select options={ROLE_OPTIONS} defaultValue={m.role} aria-label={`Role for ${m.name}`} />
                  </div>
                )}
                {m.kind === "invite" && <Badge tone="warning" icon="clock" size="sm">Expires in 5 days</Badge>}
              </div>
              <span className="inline-flex justify-center text-text-muted"><KitIcon name="more" size={16} /></span>
            </div>
          ))}
        </div>
        <div className="m-3 flex flex-col gap-1.5 rounded-lg border border-border bg-surface-inset px-3 py-2.5 md:mx-5 md:mt-auto md:mb-4">
          <span className="flex min-w-0 items-start gap-2 md:items-center">
            <span className="inline-flex pt-0.5 text-text-muted md:pt-0"><KitIcon name="folder" size={14} /></span>
            <span className="flex min-w-0 flex-wrap gap-x-0.5 font-mono text-caption">
              <span className="text-text-secondary">docs.example.com</span>
              <span className="text-text-muted">/</span>
              <span className="rounded-sm bg-accent-soft px-1 text-accent-text">engineering</span>
              <span className="text-text-muted">/</span>
              <span className="rounded-sm bg-accent-soft px-1 text-accent-text">specs</span>
              <span className="text-text-muted">/</span>
              <span className="px-1 text-text">api-v2</span>
            </span>
          </span>
          <span className="text-caption text-text-secondary">Folders file. They never grant access.</span>
        </div>
      </div>
    </Illustration>
  );
}

function Workspaces() {
  return (
    <section id="workspaces" aria-labelledby="ws-title" className={SECTION}>
      <div className={`${CONTAINER} grid gap-10 lg:grid-cols-[420px_minmax(0,1fr)] lg:gap-16`}>
        <div className="min-w-0">
          <SectionHead
            eyebrow="Workspaces"
            id="ws-title"
            title="Your team, in one place"
            lead="Invite people by email and give each a role. Nothing changes for them until they accept."
          />
          <ul className="m-0 mt-6 flex list-none flex-col p-0">
            {ROLES.map((r) => (
              <li key={r.name} className="flex items-start gap-3.5 border-b border-border py-3 md:min-h-11 md:items-center md:py-2">
                <span aria-hidden="true" className={`${s.pips} mt-0.5 md:mt-0`}>
                  {[0, 1, 2, 3].map((i) => <i key={i} data-on={i < r.pips ? "" : undefined} />)}
                </span>
                <div className="flex min-w-0 flex-col md:flex-row md:items-center md:gap-3.5">
                  <strong className="text-body-strong md:w-15 md:flex-none">{r.name}</strong>
                  <span className="text-body text-text-secondary">{r.d}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className={`${s.lift} mt-5 rounded-xl border border-border bg-surface px-4 py-3.5`}>
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="relative inline-flex h-5 w-9 flex-none rounded-full bg-accent">
                <span className="absolute top-0.5 right-0.5 size-4 rounded-full bg-on-accent" />
              </span>
              <span className="text-body text-text">Require sign-in to read this workspace</span>
            </div>
            <p className="mt-1.5 ml-12 text-caption text-text-muted">Enforced everywhere, including markdrop.in links.</p>
          </div>
        </div>
        <div className="min-w-0">
          <WorkspaceMock />
        </div>
      </div>
    </section>
  );
}

function SharePanel() {
  return (
    <Illustration
      label="The Share dialog for Q3 roadmap: general access set to Workspace, so every member of Acme Docs can read it, plus two people added by email who can view or edit"
      className={`${s.panel} min-w-0`}
    >
      <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-border-strong md:hidden" />
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 md:min-h-16 md:px-5">
        <div className="min-w-0 flex-1">
          <div className="text-h3">Share “Q3 roadmap”</div>
          <div className="text-caption text-text-muted">In Acme Docs · engineering</div>
        </div>
        <span className="inline-flex size-9 items-center justify-center text-text-secondary"><KitIcon name="x" size={18} /></span>
      </div>
      <div className="px-4 py-4 md:px-5">
        <div className="text-eyebrow text-text-muted uppercase">General access</div>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {LEVELS.map((l) => (
            <div key={l.id} className={`${s.level} ${l.on ? s.levelOn : ""}`}>
              <span className={`flex items-center gap-2 ${l.on ? "text-accent-text" : "text-text-muted"}`}>
                <KitIcon name={l.icon} size={16} />
                <span className="flex-1 text-body-strong text-text">{l.t}</span>
                <span className={`${s.radio} ${l.on ? s.radioOn : ""}`} />
              </span>
              <span className="text-caption text-text-secondary">{l.d}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 flex gap-1.5 text-caption text-text-secondary">
          <span className="inline-flex pt-0.5"><KitIcon name="info" size={12} /></span>
          Members of Acme Docs can read it, and so can the people you add below.
        </p>
        <div className="mt-4 text-eyebrow text-text-muted uppercase">People with access</div>
        <div className="mt-2 flex gap-2">
          <div className="min-w-0 flex-1"><Input prefix="user" placeholder="Add people by email" aria-label="Add people by email" /></div>
          <Button variant="secondary">Add</Button>
        </div>
        <div className="mt-1.5">
          {GRANTS.map((g) => (
            <div key={g.name} className="flex min-h-12 items-center gap-2.5 py-1">
              <Avatar name={g.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body-strong leading-[18px]">{g.name}</div>
                <div className="truncate text-caption text-text-muted">{g.email}</div>
              </div>
              {g.owner ? (
                <span className="pr-3 text-caption text-text-muted">Owner</span>
              ) : (
                <div className="w-30 flex-none md:w-33">
                  <Select
                    options={[{ value: "viewer", label: "Can view" }, { value: "editor", label: "Can edit" }]}
                    defaultValue={g.role}
                    aria-label={`Access for ${g.name}`}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-border bg-surface-inset px-4 py-3 md:flex-row md:items-center md:px-5">
        <Switch readOnly label="Let editors share it" />
        <Button iconLeft="copy" className="md:ml-auto max-md:w-full">Copy link</Button>
      </div>
    </Illustration>
  );
}

function Access() {
  return (
    <section id="access" aria-labelledby="access-title" className={`${SECTION} border-t border-border`}>
      <div className={`${CONTAINER} ${s.accessGrid}`}>
        <div className={s.accessCopy}>
          <SectionHead
            eyebrow="Access"
            id="access-title"
            title="Decide who reads each document"
            lead="Pick a level, then add people by email. A level only narrows who can read it; a person you add only widens it."
          />
        </div>
        <div className={s.accessPanel}>
          <SharePanel />
        </div>
        <div className={s.accessGate}>
          <p className="text-eyebrow text-text-muted uppercase">What everyone else sees</p>
          <Illustration
            label="What a reader without access sees: This document is private. Sign in with the address it was shared with and it'll open."
            className="mt-2.5 block min-w-0"
          >
            <AccessGate mode="signin" signInHref="/login" />
          </Illustration>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section aria-labelledby="features-title" className={`${SECTION} border-t border-border`}>
      <div className={CONTAINER}>
        <SectionHead eyebrow="In every workspace" id="features-title" title="What comes with it" />
        <ul className="m-0 mt-8 grid list-none grid-cols-2 gap-3 p-0 md:gap-4 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.t} className="min-w-0">
              <Card compact className={`${s.lift} h-full`}>
                <span aria-hidden="true" className="inline-flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
                  <KitIcon name={f.icon} size={18} />
                </span>
                <h3 className="mt-3 text-body-strong md:text-h4">{f.t}</h3>
                <p className="mt-1 text-caption text-text-secondary md:text-body">{f.d}</p>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function BoundaryList({ items, icon }: { items: { t: string; d: string }[]; icon: string }) {
  return (
    <ul className="m-0 mt-4 flex list-none flex-col gap-3 p-0">
      {items.map((it) => (
        <li key={it.t} className="flex gap-2.5">
          <span aria-hidden="true" className="inline-flex pt-0.5 text-text-muted"><KitIcon name={icon} size={16} /></span>
          <div className="min-w-0">
            <div className="text-body-strong">{it.t}</div>
            <div className="mt-0.5 text-caption text-text-secondary">{it.d}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Privacy() {
  return (
    <section id="privacy" aria-labelledby="privacy-title" className={`${SECTION} border-t border-border`}>
      <div className={CONTAINER}>
        <SectionHead eyebrow="The privacy boundary" id="privacy-title" title="What admins can see, and what they can’t" />
        <div className={`${s.boundary} mt-7`}>
          <div className={`${s.lift} min-w-0 rounded-xl border border-border bg-surface p-4 md:p-5`}>
            <h3 className="flex items-center gap-2.5 text-h4">
              <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
                <KitIcon name="eye" size={16} />
              </span>
              Workspace admins can see
            </h3>
            <BoundaryList items={CAN_SEE} icon="check" />
          </div>
          <div className={s.divider} aria-hidden="true">
            <span className={s.dividerKnob}><KitIcon name="eyeOff" size={16} /></span>
          </div>
          <div className="min-w-0 rounded-xl border border-border-strong bg-surface-inset p-4 md:p-5">
            <h3 className="flex items-center gap-2.5 text-h4">
              <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
                <KitIcon name="eyeOff" size={16} />
              </span>
              They never see
            </h3>
            <BoundaryList items={NEVER_SEE} icon="minus" />
          </div>
        </div>

        {/* The honesty block stays (REVAMP_PLAN 7.2 §4). */}
        <Alert tone="info" title="Worth knowing" className="mt-6">
          <ul className="m-0 mt-1 grid list-none gap-3 p-0 md:grid-cols-3 md:gap-6">
            {CAVEATS.map((c) => (
              <li key={c.t} className="text-caption text-text-secondary">
                <span className="font-semibold text-text">{c.t}</span> {c.d}
              </li>
            ))}
          </ul>
        </Alert>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section aria-labelledby="close-title" className={`${s.closeBand} border-t border-border bg-surface-inset py-16 md:py-20`}>
      <div className={s.closeDots} aria-hidden="true" />
      <div className="mx-auto flex w-full max-w-[640px] flex-col items-center px-4 text-center sm:px-6">
        <div aria-hidden="true" className="flex items-center gap-3.5 text-text-muted">
          <MarkdropMark size={40} />
          <KitIcon name="arrowRight" size={18} />
          <span className={`${s.tenantMark} size-10 rounded-lg text-xl shadow-md`}>A</span>
        </div>
        <h2 id="close-title" className="mt-4.5 text-[32px] leading-9 font-extrabold tracking-[-0.025em] md:text-display">
          Put your name on it
        </h2>
        <p className="mt-2.5 text-body-lg text-text-secondary md:text-lg md:leading-7">
          Create a workspace, add your domain and invite your team. Or tell us what you need first.
        </p>
        <div className="mt-6 w-full sm:w-auto">
          <Ctas center />
        </div>
        <ContactLine className="mt-3" />
      </div>
    </section>
  );
}

export default function EnterprisePage() {
  return (
    <div className="w-full min-w-0 overflow-x-clip">
      <Hero />
      <Domains />
      <WhiteLabel />
      <Workspaces />
      <Access />
      <Features />
      <Privacy />
      <Close />
    </div>
  );
}
