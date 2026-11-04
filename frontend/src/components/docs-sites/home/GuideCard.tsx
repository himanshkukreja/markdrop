"use client";

import { Anchor, Badge, Button, Dropdown, Icon, IconButton, Skeleton, copyText, cx, useToast, type MenuEntry } from "@/components/ui";
import { preloadDocsEditor } from "@/components/docs-editor";
import { canEditRole, isAdminRole, type HomeSiteInsights, type SiteSummary } from "@/lib/docsSites";
import { num, plural } from "../format";
import { PeopleStack } from "../people/PeopleStack";
import { RoleBadge } from "../people/roles";
import { siteBase, studioMembers } from "../routes";
import { GuideMark, GuidePreview, usePreviewDark } from "./GuidePreview";
import { SECURING_COPIED, SECURING_TEXT } from "../AddressSecuring";
import { addressOf, isLive, isSecuring, lastChange, noteOf, stateOf } from "./model";
import { Sparkline } from "./Sparkline";

/** The home's numbers for one guide: still loading, unavailable (the call failed), or the API's. */
export type CardInsights = { state: "loading" } | { state: "error" } | { state: "ok"; data: HomeSiteInsights | undefined; days: string[] };

export interface GuideItemProps {
  site: SiteSummary;
  /** "Personal" or the workspace's name. */
  where: string;
  insights: CardInsights;
  /** You manage the people of the guide's workspace (Members in its menu). */
  canManagePeople?: boolean;
  onDelete: (site: SiteSummary) => void;
}

const viewsOf = (ins: CardInsights) => (ins.state === "ok" && ins.data?.enabled ? ins.data : null);

/** "Open editor" (or "Open" for viewers), preloading the editor's code on hover / focus. */
function OpenButton({ site, className, block }: { site: SiteSummary; className?: string; block?: boolean }) {
  return (
    <span onPointerEnter={preloadDocsEditor} onFocus={preloadDocsEditor} className={className}>
      <Button variant="secondary" size="sm" iconLeft="edit" href={siteBase(site.id)} block={block} aria-label={`${canEditRole(site.your_role) ? "Open editor for" : "Open"} ${site.name}`}>
        {canEditRole(site.your_role) ? "Open editor" : "Open"}
      </Button>
    </span>
  );
}

/** View (live: the published guide, new tab) or Preview (not live: the editor's preview of its home page). */
function ViewButton({ site, className }: { site: SiteSummary; className?: string }) {
  if (isSecuring(site)) {
    return (
      <Button variant="ghost" size="sm" iconLeft="eye" href={`https://${addressOf(site)}`} disabled className={className} title={SECURING_TEXT}
        aria-label={`View ${site.name}: available once its address is secured`}>
        View
      </Button>
    );
  }
  if (isLive(site)) {
    return (
      <Button variant="ghost" size="sm" iconLeft="eye" href={`https://${addressOf(site)}`} target="_blank" className={className} aria-label={`View ${site.name} (opens in a new tab)`}>
        View
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="sm" iconLeft="eye" href={`${siteBase(site.id)}?preview=1`} className={className} aria-label={`Preview ${site.name}`}>
      Preview
    </Button>
  );
}

/** Settings › People: who works on the guide (its admins change roles there). */
export const peopleHref = (siteId: string) => `${siteBase(siteId)}/settings/people`;

/** The guide's other screens and actions: Design, Publish, Fix list, Insights, Settings; People and
 * the workspace's Guides members; copy its address; Delete. The same menu on cards and rows. */
function MoreMenu({ site, canManagePeople, onDelete }: Pick<GuideItemProps, "site" | "canManagePeople" | "onDelete">) {
  const toast = useToast();
  const base = siteBase(site.id);
  const admin = isAdminRole(site.your_role);
  const items: MenuEntry[] = [
    { label: "Design", href: `${base}/design`, icon: "image" },
    { label: "Publish", description: "Changes, reviews and history", href: `${base}/publish`, icon: "history" },
    { label: "Fix list", href: `${base}/fixes`, icon: "flag" },
    { label: "Insights", href: `${base}/insights`, icon: "chart" },
    { label: "Settings", href: `${base}/settings`, icon: "settings" },
  ];
  if (site.workspace_id) {
    items.push({
      label: "People",
      description: admin ? "Who works on it, and their roles" : "Who works on this guide",
      href: peopleHref(site.id),
      icon: "users",
      separated: true,
    });
    if (canManagePeople) items.push({ label: "Workspace members", description: "Guides roles across the workspace", href: studioMembers(site.workspace_id), icon: "folder" });
  }
  if (isLive(site)) {
    items.push({
      label: "Copy address", icon: "copy", separated: true,
      onClick: async () => {
        if (!(await copyText(`https://${addressOf(site)}`))) return;
        if (isSecuring(site)) toast.info(SECURING_COPIED);
        else toast.success("The guide's address is on the clipboard.");
      },
    });
  }
  if (admin) items.push({ label: "Delete guide…", icon: "trash", danger: true, separated: true, onClick: () => onDelete(site) });
  return (
    <Dropdown
      align="right"
      portal
      minWidth={240}
      aria-label={`More for ${site.name}`}
      trigger={<IconButton icon="more" label={`More for ${site.name}`} size="sm" className="max-sm:size-11" />}
      items={items}
    />
  );
}

/** The guide's people (workspace guides): the avatar stack, a link to its Settings › People. */
function GuidePeople({ site, className, size, tipSide }: { site: SiteSummary; className?: string; size?: number; tipSide?: "top" | "bottom" }) {
  if (!site.workspace_id || !site.people?.length) return null;
  return <PeopleStack people={site.people} count={site.people_count ?? site.people.length} href={peopleHref(site.id)} guide={site.name} size={size} className={className} tipSide={tipSide} />;
}

function StatusBadge({ site }: { site: SiteSummary }) {
  const st = stateOf(site);
  return <Badge tone={st.tone} size="sm" dot title={st.title} className="shrink-0">{st.label}</Badge>;
}

/** The address: a link to the live guide, plain text before it's published. Truncates, full text in the title. */
function Address({ site, className }: { site: SiteSummary; className?: string }) {
  const address = addressOf(site);
  const cls = cx("flex min-w-0 items-center gap-1.5 font-mono text-[12px] leading-4 text-text-secondary", className);
  if (!isLive(site)) {
    return <span className={cls} title={`${address} (not live)`}><span className="ph-sensitive ph-mask truncate">{address}</span></span>;
  }
  if (isSecuring(site)) {
    return (
      <span className={cls} title={`${address}: securing the address. ${SECURING_TEXT}`}>
        <Icon name="lock" size={12} className="shrink-0 text-accent-text" />
        <span className="ph-sensitive ph-mask truncate">{address}</span>
      </span>
    );
  }
  return (
    <a href={`https://${address}`} target="_blank" rel="noopener noreferrer" className={cx(cls, "md-focus md-touch-hit max-w-full self-start rounded no-underline hover:text-text hover:underline")} title={`${address} (opens in a new tab)`}>
      <span className="ph-sensitive ph-mask truncate">{address}</span>
      <Icon name="external" size={12} className="shrink-0" />
    </a>
  );
}

/** "Personal · 42 pages · Published 2 hours ago". */
function Meta({ site, where, extra, className }: { site: SiteSummary; where: string; extra?: string | null; className?: string }) {
  const change = lastChange(site);
  return (
    <div className={cx("flex min-w-0 items-center gap-2 text-[12px] leading-4 text-text-muted", className)}>
      <span className="inline-flex min-w-[3rem] shrink-[3] items-center gap-1" title={site.workspace_id ? `In the ${where} workspace` : "Your personal guide"}>
        <Icon name={site.workspace_id ? "folder" : "user"} size={12} className="shrink-0" />
        <span className="ph-sensitive ph-mask truncate" dir="auto">{where}</span>
      </span>
      <span aria-hidden>·</span>
      <span className="shrink-0">{plural(site.page_count, "page")}</span>
      {extra ? <><span aria-hidden>·</span><span className={extra.length < 18 ? "shrink-0 whitespace-nowrap" : "min-w-0 truncate"} title={extra}>{extra}</span></> : <><span aria-hidden className="max-sm:hidden">·</span><span className="shrink-0 whitespace-nowrap max-sm:hidden" title={change}>{change}</span></>}
    </div>
  );
}

/** Views, the sparkline and % helpful for a live guide; "Insights is off"; "—" when unavailable. */
function Numbers({ ins, compact }: { ins: CardInsights; compact?: boolean }) {
  if (ins.state === "loading") {
    return <div className="flex items-center gap-3" aria-label="Loading numbers"><Skeleton width={72} height={18} /><Skeleton width={110} /></div>;
  }
  if (ins.state === "ok" && ins.data && !ins.data.enabled) {
    return <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted"><Icon name="eye" size={13} /> Insights is off for this guide</span>;
  }
  const v = viewsOf(ins);
  const days = ins.state === "ok" ? ins.days : undefined;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {v && !compact && <Sparkline values={v.views} days={days} />}
      <span className="shrink-0 text-[12px] text-text-secondary"><strong className="font-semibold text-text">{v ? num(v.views_total) : "—"}</strong> views</span>
      <span className="min-w-0 truncate text-[12px] text-text-secondary" title={v && v.helpful_pct !== null ? `${v.helpful_pct}% of readers who voted found it helpful` : undefined}>
        {v && v.helpful_pct === null
          ? "No feedback yet"
          : <><strong className="font-semibold text-text">{v ? `${v.helpful_pct}%` : "—"}</strong> found it helpful</>}
      </span>
    </div>
  );
}

/** "3 to fix" (the Fix list's open items; red when one is high impact), linking to the Fix list. */
function FixChip({ ins, site, className }: { ins: CardInsights; site: SiteSummary; className?: string }) {
  const f = viewsOf(ins)?.fixes;
  if (!f?.open) return null;
  const words = `${num(f.open)} ${f.open === 1 ? "thing" : "things"} to fix`;
  return (
    <Anchor href={`${siteBase(site.id)}/fixes`} title={f.high ? `${words}, ${f.high} high impact` : words}
      className={cx("md-focus md-touch-hit inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-semibold no-underline hover:underline",
        f.high ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning", className)}>
      <Icon name="flag" size={12} />{num(f.open)} to fix<span className="md-visually-hidden"> in {site.name}</span>
    </Anchor>
  );
}

/** A guide that isn't (only) live: its one-line note. */
function Note({ text, icon = "edit" }: { text: string; icon?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[12px] text-text-secondary">
      <Icon name={icon} size={13} className="shrink-0" />
      <span className="truncate" title={text}>{text}</span>
    </span>
  );
}

/**
 * A guide on the home (Main board): its preview in its own theme (a link to the editor for the
 * mouse; the buttons below are the keyboard's way), name and state, address, workspace · pages ·
 * last change, the 7-day numbers (live) or a note (draft / review), then Open editor, View or
 * Preview, and More. Phones (Phone board): the guide's mark beside its name instead of the preview.
 */
export function GuideCard({ site, where, insights, canManagePeople, onDelete }: GuideItemProps) {
  const note = noteOf(site);
  const live = isLive(site);
  const showNumbers = live && !site.in_review && !isSecuring(site);
  const v = viewsOf(insights);
  const dark = usePreviewDark(site.theme);
  const phoneExtra = showNumbers ? (v ? `${num(v.views_total)} views` : null) : note;
  return (
    <article className="ph-no-capture flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm" aria-label={site.name}>
      <Anchor href={siteBase(site.id)} tabIndex={-1} aria-hidden className="block bg-surface-inset px-3.5 pt-3.5 max-sm:hidden" onPointerEnter={preloadDocsEditor}>
        <GuidePreview site={site} />
      </Anchor>
      <div className="flex min-w-0 flex-1 gap-3 border-border px-4 pb-3 pt-3.5 sm:border-t">
        <span className="sm:hidden"><GuideMark site={site} size={44} dark={dark} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-2 max-sm:gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="ph-sensitive ph-mask min-w-0 flex-1 truncate text-[16px] font-semibold leading-6 text-text" dir="auto" title={site.name}>{site.name}</h3>
            <StatusBadge site={site} />
          </div>
          <Address site={site} />
          <Meta site={site} where={where} className="sm:hidden" extra={phoneExtra} />
          <Meta site={site} where={where} className="max-sm:hidden" />
          <div className="mt-auto flex min-h-[38px] items-center rounded-lg bg-surface-inset px-2.5 py-2 max-sm:hidden">
            {showNumbers ? <Numbers ins={insights} /> : <Note text={note ?? "Live"} icon={isSecuring(site) ? "lock" : undefined} />}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2.5">
        <OpenButton site={site} className="max-sm:flex-1" block />
        <ViewButton site={site} />
        {showNumbers && <FixChip ins={insights} site={site} />}
        <span className="flex-1 max-sm:hidden" />
        {!isAdminRole(site.your_role) && <RoleBadge role={site.your_role} className="max-lg:hidden" title={site.your_role_source === "site" ? "Your role on this guide (different from your workspace role)" : "Your Guides role"} />}
        <GuidePeople site={site} />
        <MoreMenu site={site} canManagePeople={canManagePeople} onDelete={onDelete} />
      </div>
    </article>
  );
}

/** The list layout's row: mark, name and state, address, meta, numbers or note, actions. */
export function GuideRow({ site, where, insights, canManagePeople, onDelete }: GuideItemProps) {
  const note = noteOf(site);
  const showNumbers = isLive(site) && !site.in_review && !isSecuring(site);
  const dark = usePreviewDark(site.theme);
  return (
    <li className="ph-no-capture flex min-w-0 items-center gap-3 px-4 py-3 max-md:flex-wrap" aria-label={site.name}>
      <GuideMark site={site} size={36} dark={dark} />
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="ph-sensitive ph-mask min-w-0 truncate text-body-strong text-text" dir="auto" title={site.name}>{site.name}</h3>
          <StatusBadge site={site} />
        </div>
        <Address site={site} />
      </div>
      <Meta site={site} where={where} className="w-[230px] shrink-0 max-xl:hidden" />
      <div className="flex w-[240px] min-w-0 shrink-0 items-center max-lg:hidden">
        {showNumbers ? <Numbers ins={insights} /> : <Note text={note ?? "Live"} icon={isSecuring(site) ? "lock" : undefined} />}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {showNumbers && <FixChip ins={insights} site={site} className="max-sm:hidden" />}
        <GuidePeople site={site} className="mr-1" />
        <OpenButton site={site} />
        <ViewButton site={site} />
        <MoreMenu site={site} canManagePeople={canManagePeople} onDelete={onDelete} />
      </div>
    </li>
  );
}

/** A card while the listing loads (same frame as GuideCard). */
export function GuideCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface" aria-hidden>
      <div className="bg-surface-inset px-3.5 pt-3.5 max-sm:hidden"><Skeleton variant="rect" height={132} className="rounded-b-none" /></div>
      <div className="flex flex-col gap-2.5 px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2"><Skeleton width="55%" height={18} /><span className="flex-1" /><Skeleton width={52} height={18} /></div>
        <Skeleton width="65%" />
        <Skeleton width="80%" />
        <Skeleton variant="rect" height={38} className="max-sm:hidden" />
      </div>
      <div className="flex gap-2 border-t border-border px-3 py-2.5"><Skeleton width={110} height={30} /><Skeleton width={70} height={30} /></div>
    </div>
  );
}

export default GuideCard;
