"use client";

/**
 * Choose what's tracked (backend services/analytics_prefs.py): nine kinds of analytics, each on or
 * off, at four levels — your account's defaults, a workspace's (with "enforce"), a folder's, and an
 * item's own ("Use my defaults" or custom). Turning a kind off asks whether to also delete what was
 * already collected. Shared by Settings › Account, the workspace's Advanced tab, a folder's menu,
 * an item's menu, the share dialog, the analytics page header and My files' bulk actions.
 */
import { useEffect, useId, useState } from "react";
import { Badge, Button, Card, Checkbox, Dialog, Drawer, Icon, SegmentedControl, Select, Skeleton, Switch, cx, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { usePhone } from "@/components/dashboard/hooks";
import {
  TRACK_KEYS, getFolderTrack, getItemTrack, getMyTrack, getWorkspaceTrack, putFolderTrack, putItemTrack, putItemsTrack,
  putMyTrack, putWorkspaceTrack, type ItemTrackSettings, type Track, type TrackKey, type TrackPartial,
} from "@/lib/analytics";

export const TRACK_LABEL: Record<TrackKey, string> = {
  counts: "View counts and totals", identity: "Viewer identity", location: "Location", device: "Device and system",
  source: "Source and referrer", activity: "Activity timeline", video: "Video watching", pages: "PDF pages and slides",
  downloads: "Downloads",
};
export const TRACK_HELP: Record<TrackKey, string> = {
  counts: "Views, people and time. Off: nothing at all is recorded for the item.",
  identity: "Names and emails of signed-in viewers. Off: their views are stored as anonymous visitors.",
  location: "Country, region, city and timezone. Off: no location is looked up.",
  device: "Phone, tablet or computer; OS and browser with versions; screen, language, app.",
  source: "Where people came from: the referring site, email, Slack, campaign tags.",
  activity: "Sections read, scroll depth, links opened, code copied, prints, Ask questions and sign-offs.",
  video: "What was watched, paused and skipped, speed and playback quality.",
  pages: "PDF pages, slides and spreadsheet tabs viewed.",
  downloads: "Downloads and PDF exports.",
};
const ALL_ON: Track = Object.fromEntries(TRACK_KEYS.map((k) => [k, true])) as Track;

/** "Tracking everything" · "Tracking: counts, location · identity off" · "Not tracked" (as the backend says it). */
export function trackSummary(t: Partial<Track>): string {
  if (t.counts === false) return "Not tracked";
  const off = TRACK_KEYS.filter((k) => k !== "counts" && t[k] === false);
  if (!off.length) return "Tracking everything";
  return `Tracking: ${TRACK_KEYS.filter((k) => t[k] !== false).join(", ")} · ${off.join(", ")} off`;
}

export function TrackingChip({ summary, onClick, className }: { summary: string; onClick?: () => void; className?: string }) {
  const off = summary !== "Tracking everything";
  // Short on the chip ("Tracking · identity, location off"); the whole sentence in its name and title.
  const short = summary.startsWith("Tracking: ") ? `Tracking · ${summary.split(" · ").slice(1).join(" · ")}` : summary;
  const body = (
    <>
      <Icon name={summary === "Not tracked" ? "eyeOff" : "eye"} size={14} aria-hidden />
      <span className="min-w-0 truncate" title={summary}>{short}</span>
    </>
  );
  const cls = cx("inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption",
    off ? "border-border-strong bg-surface-inset text-text" : "border-border text-text-secondary", className);
  return onClick
    ? <button type="button" onClick={onClick} className={cx(cls, "hover:bg-surface-hover pointer-coarse:min-h-11")} aria-label={`Analytics settings: ${summary}`}>{body}<Icon name="chevronRight" size={12} aria-hidden /></button>
    : <span className={cls}>{body}</span>;
}

/** Turned off since `before`: the kinds whose collected data could be deleted too. */
const turnedOff = (before: Partial<Track>, after: Partial<Track>) =>
  TRACK_KEYS.filter((k) => before[k] !== false && after[k] === false);

/** "Also delete what was already collected?" before saving a change that turns kinds off. */
function OffConfirm({ keys, open, busy, onCancel, onSave, scope }: {
  keys: TrackKey[]; open: boolean; busy: boolean; onCancel: () => void; onSave: (del: TrackKey[]) => void; scope: string;
}) {
  const [del, setDel] = useState(false);
  useEffect(() => { if (open) setDel(false); }, [open]);
  return (
    <Dialog open={open} onClose={onCancel} title={`Stop collecting ${keys.length === 1 ? TRACK_LABEL[keys[0]!].toLowerCase() : "these"}?`}
      description={`From now on, ${scope} won't collect: ${keys.map((k) => TRACK_LABEL[k].toLowerCase()).join(", ")}.`}
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant={del ? "danger" : "primary"} loading={busy} onClick={() => onSave(del ? keys : [])}>
            {del ? "Turn off and delete" : "Turn off"}
          </Button>
        </>
      )}>
      <Checkbox checked={del} onChange={(e) => setDel(e.target.checked)} label="Also delete what was already collected"
        description="This can't be undone. Totals on the other analytics tabs that came from it go too." />
    </Dialog>
  );
}

/** Nine switches (an item's custom settings, your defaults). */
function SwitchList({ value, onChange, locked, from, disabled }: {
  value: Partial<Track>; onChange: (k: TrackKey, on: boolean) => void;
  locked?: Partial<Record<TrackKey, boolean>>; from?: Partial<Record<TrackKey, string>>; disabled?: boolean;
}) {
  const uid = useId();
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {TRACK_KEYS.map((k) => {
        const off = value.counts === false && k !== "counts";
        return (
          <li key={k} className="flex min-h-11 items-start justify-between gap-4 border-t border-border py-2.5 first:border-t-0">
            <div className="min-w-0">
              <label htmlFor={`${uid}-${k}`} id={`${uid}-l-${k}`} className={cx("m-0 block text-body-strong", off ? "text-text-muted" : "text-text")}>
                {TRACK_LABEL[k]}
                {locked?.[k] && <Badge size="sm" tone="neutral" className="ml-2" icon="lock">Locked</Badge>}
              </label>
              <p className="m-0 mt-0.5 text-caption text-text-muted">{TRACK_HELP[k]}{from?.[k] ? <span className="block text-micro">From: {from[k]}</span> : null}</p>
            </div>
            <Switch className="mt-0.5 shrink-0" id={`${uid}-${k}`} checked={value[k] !== false} aria-label={TRACK_LABEL[k]}
              disabled={disabled || !!locked?.[k]} onChange={(e) => onChange(k, e.target.checked)} />
          </li>
        );
      })}
    </ul>
  );
}

const INHERIT = "inherit";
/** Nine three-way choices (a workspace's or folder's defaults: inherit, on, off). */
function TriList({ value, onChange, disabled, inheritWord }: {
  value: TrackPartial; onChange: (k: TrackKey, v: boolean | null) => void; disabled?: boolean; inheritWord: string;
}) {
  const uid = useId();
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {TRACK_KEYS.map((k) => (
        <li key={k} className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border py-2.5 first:border-t-0">
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor={`${uid}-${k}`} className="m-0 block text-body-strong text-text">{TRACK_LABEL[k]}</label>
            <p className="m-0 mt-0.5 text-caption text-text-muted">{TRACK_HELP[k]}</p>
          </div>
          <div className="w-full sm:w-44">
            <Select id={`${uid}-${k}`} disabled={disabled} value={value[k] === undefined ? INHERIT : value[k] ? "on" : "off"}
              onChange={(e) => onChange(k, e.target.value === INHERIT ? null : e.target.value === "on")}
              options={[{ value: INHERIT, label: inheritWord }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ── An item (or several) ─────────────────────────────────────────────── */

/**
 * The item's analytics settings in a drawer (a bottom sheet on phones): "Use my defaults" or
 * "Custom", each kind with where its value comes from and whether the workspace locks it. With
 * `slugs` (bulk): the same settings for every one of them.
 */
export function ItemTrackDrawer({ slug, slugs, open, onClose, onSaved }: {
  slug?: string | null; slugs?: string[]; open: boolean; onClose: () => void; onSaved?: (summary: string) => void;
}) {
  const phone = usePhone();
  const toast = useToast();
  const bulk = !slug && !!slugs?.length;
  const [data, setData] = useState<ItemTrackSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"defaults" | "custom">("defaults");
  const [value, setValue] = useState<Partial<Track>>(ALL_ON);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<TrackKey[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirm(null);
    if (bulk) {
      setData(null);
      setMode("custom");
      setValue(ALL_ON);
      return;
    }
    if (!slug) return;
    let live = true;
    setData(null);
    getItemTrack(slug)
      .then((d) => { if (!live) return; setData(d); setMode(d.custom ? "custom" : "defaults"); setValue(d.effective); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [open, slug, bulk]);

  const locked = Object.fromEntries((data?.types ?? []).map((t) => [t.key, t.locked])) as Partial<Record<TrackKey, boolean>>;
  const from = Object.fromEntries((data?.types ?? []).map((t) => [t.key, t.from])) as Partial<Record<TrackKey, string>>;
  const before: Partial<Track> = data?.effective ?? ALL_ON;
  const canChange = bulk || data?.can_change !== false;

  async function save(del: TrackKey[]) {
    setBusy(true);
    try {
      const settings = mode === "defaults" ? null : (value as TrackPartial);
      if (bulk) {
        const r = await putItemsTrack(slugs!, settings, del);
        toast.success(r.skipped.length ? `Saved for ${r.updated.length}; ${r.skipped.length} you can't change were skipped.` : `Saved for ${r.updated.length} item${r.updated.length === 1 ? "" : "s"}.`);
        onSaved?.(settings ? trackSummary(value) : "Using defaults");
      } else {
        const d = await putItemTrack(slug!, settings, del);
        setData(d);
        setValue(d.effective);
        toast.success(del.length ? "Saved, and the collected data was deleted." : "Saved.");
        onSaved?.(d.summary);
      }
      setConfirm(null);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function trySave() {
    const after = mode === "custom" ? value : (data ? null : ALL_ON);
    const off = after ? turnedOff(before, after) : [];
    if (off.length) setConfirm(off);
    else void save([]);
  }

  const shown = mode === "custom" ? value : data?.effective ?? ALL_ON;
  return (
    <>
      <Drawer open={open && !confirm} onClose={onClose} side={phone ? "bottom" : "right"} width={480}
        title={bulk ? `Analytics settings for ${slugs!.length} items` : "Analytics settings"}
        description={bulk ? "The same settings for each. A kind the workspace locks stays off." : data ? <TrackingChip summary={data.summary} /> : undefined}
        footer={canChange ? (
          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={trySave} loading={busy} disabled={!bulk && !data}>Save</Button>
          </div>
        ) : undefined}>
        {error ? <p className="m-0 text-[13px] text-danger">{error}</p> : !bulk && !data ? (
          <div className="flex flex-col gap-3" aria-busy><Skeleton width="60%" /><Skeleton variant="rect" height={300} /></div>
        ) : (
          <div className="flex flex-col gap-4">
            <SegmentedControl block size="sm" aria-label="Settings" value={mode} disabled={!canChange}
              onChange={(m) => { setMode(m); if (m === "custom" && data && !data.custom) setValue(data.effective); }}
              options={[{ value: "defaults", label: bulk ? "Use the defaults" : "Use my defaults" }, { value: "custom", label: "Custom" }]} />
            <p className="m-0 text-caption text-text-muted">
              {mode === "defaults"
                ? "Follows its folder, its workspace and your account's defaults, as each is set. Each kind says where its value comes from."
                : "These apply to this item whatever its folder, workspace or your defaults say, except a kind its workspace locks off."}
              {" "}<ReadMore topic="viewers" />
            </p>
            <SwitchList value={shown} onChange={(k, on) => setValue((v) => ({ ...v, [k]: on }))}
              locked={locked} from={mode === "defaults" ? from : undefined} disabled={mode === "defaults" || !canChange} />
            {!canChange && <p className="m-0 text-caption text-text-muted">Only the owner, or the workspace&apos;s admins, can change these.</p>}
          </div>
        )}
      </Drawer>
      <OffConfirm open={!!confirm} keys={confirm ?? []} busy={busy} onCancel={() => setConfirm(null)} onSave={(del) => void save(del)}
        scope={bulk ? "these items" : "this item"} />
    </>
  );
}

/* ── Your defaults (Settings › Account) ───────────────────────────────── */

export function AccountTrackCard() {
  const toast = useToast();
  const [saved, setSaved] = useState<Track | null>(null);
  const [value, setValue] = useState<Track | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<TrackKey[] | null>(null);

  useEffect(() => {
    let live = true;
    getMyTrack().then((r) => { if (live) { setSaved(r.settings); setValue(r.settings); } }).catch(() => {});
    return () => { live = false; };
  }, []);

  async function save(del: TrackKey[]) {
    if (!value) return;
    setBusy(true);
    try {
      const r = await putMyTrack(value, del);
      setSaved(r.settings);
      setValue(r.settings);
      setConfirm(null);
      toast.success(del.length ? "Saved, and the collected data was deleted." : "Saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const dirty = !!saved && !!value && TRACK_KEYS.some((k) => saved[k] !== value[k]);

  return (
    <Card title="Analytics" id="analytics" description="What your documents and files collect about their viewers, unless an item, its folder or its workspace says otherwise.">
      {!value ? <Skeleton variant="rect" height={260} /> : (
        <div className="flex flex-col gap-3">
          <TrackingChip summary={trackSummary(value)} className="self-start" />
          <SwitchList value={value} onChange={(k, on) => setValue((v) => (v ? { ...v, [k]: on } : v))} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty && <Button variant="secondary" onClick={() => setValue(saved)}>Undo</Button>}
            <Button disabled={!dirty} loading={busy} onClick={() => {
              const off = turnedOff(saved!, value);
              if (off.length) setConfirm(off);
              else void save([]);
            }}>Save</Button>
          </div>
          <p className="m-0 text-caption text-text-muted">Changes apply from now on. <ReadMore topic="viewers" /></p>
        </div>
      )}
      <OffConfirm open={!!confirm} keys={confirm ?? []} busy={busy} onCancel={() => setConfirm(null)} onSave={(d) => void save(d)} scope="your items" />
    </Card>
  );
}

/* ── A workspace's or folder's defaults ───────────────────────────────── */

function LevelEditor({ load, put, canEdit, withEnforce, scope, inheritWord }: {
  load: () => Promise<{ settings: TrackPartial; enforce?: boolean }>;
  put: (s: TrackPartial, enforce: boolean, del: TrackKey[]) => Promise<{ settings: TrackPartial; enforce?: boolean }>;
  canEdit: boolean; withEnforce: boolean; scope: string; inheritWord: string;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState<{ settings: TrackPartial; enforce: boolean } | null>(null);
  const [value, setValue] = useState<TrackPartial>({});
  const [enforce, setEnforce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<TrackKey[] | null>(null);

  useEffect(() => {
    let live = true;
    load().then((r) => {
      if (!live) return;
      setSaved({ settings: r.settings, enforce: !!r.enforce });
      setValue(r.settings);
      setEnforce(!!r.enforce);
    }).catch(() => {});
    return () => { live = false; };
  }, [load]);

  async function save(del: TrackKey[]) {
    setBusy(true);
    try {
      const r = await put(value, enforce, del);
      setSaved({ settings: r.settings, enforce: !!r.enforce });
      setValue(r.settings);
      setConfirm(null);
      toast.success(del.length ? "Saved, and the collected data was deleted." : "Saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!saved) return <Skeleton variant="rect" height={260} />;
  const dirty = enforce !== saved.enforce || TRACK_KEYS.some((k) => saved.settings[k] !== value[k]);
  return (
    <div className="flex flex-col gap-3">
      <TriList value={value} disabled={!canEdit} inheritWord={inheritWord}
        onChange={(k, v) => setValue((cur) => { const n = { ...cur }; if (v === null) delete n[k]; else n[k] = v; return n; })} />
      {withEnforce && (
        <div className="flex min-h-11 items-start justify-between gap-4 border-t border-border pt-3">
          <div className="min-w-0">
            <label htmlFor="trk-enforce" className="m-0 block text-body-strong text-text">Enforce for every item</label>
            <p className="m-0 mt-0.5 text-caption text-text-muted">A kind set to Off here is off for every item in the workspace; members can&apos;t turn it back on for theirs.</p>
          </div>
          <Switch className="mt-0.5 shrink-0" id="trk-enforce" checked={enforce} disabled={!canEdit} onChange={(e) => setEnforce(e.target.checked)} />
        </div>
      )}
      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && <Button variant="secondary" onClick={() => { setValue(saved.settings); setEnforce(saved.enforce); }}>Undo</Button>}
          <Button disabled={!dirty} loading={busy} onClick={() => {
            const off = TRACK_KEYS.filter((k) => saved.settings[k] !== false && value[k] === false);
            if (off.length) setConfirm(off);
            else void save([]);
          }}>Save</Button>
        </div>
      ) : <p className="m-0 text-caption text-text-muted">Only the workspace&apos;s owner and admins can change these.</p>}
      <OffConfirm open={!!confirm} keys={confirm ?? []} busy={busy} onCancel={() => setConfirm(null)} onSave={(d) => void save(d)} scope={scope} />
    </div>
  );
}

export function WorkspaceTrackCard({ wsId, canEdit }: { wsId: string; canEdit: boolean }) {
  const [load] = useState(() => () => getWorkspaceTrack(wsId));
  const [put] = useState(() => (s: TrackPartial, enforce: boolean, del: TrackKey[]) => putWorkspaceTrack(wsId, s, enforce, del));
  return (
    <Card title="Analytics" id="analytics" description="What items in this workspace collect about their viewers. Owner's choice leaves it to each item's owner (their defaults); a folder or an item can still choose for itself unless you enforce.">
      <LevelEditor load={load} put={put} canEdit={canEdit} withEnforce scope="items in this workspace" inheritWord="Owner's choice" />
    </Card>
  );
}

export function FolderTrackDrawer({ wsId, folderId, folderName, open, onClose, canEdit }: {
  wsId: string; folderId: string | null; folderName: string; open: boolean; onClose: () => void; canEdit: boolean;
}) {
  const phone = usePhone();
  const [load, setLoad] = useState<(() => Promise<{ settings: TrackPartial }>) | null>(null);
  const [put, setPut] = useState<((s: TrackPartial, e: boolean, d: TrackKey[]) => Promise<{ settings: TrackPartial }>) | null>(null);
  useEffect(() => {
    if (!folderId) return;
    setLoad(() => () => getFolderTrack(wsId, folderId));
    setPut(() => (s: TrackPartial, _e: boolean, d: TrackKey[]) => putFolderTrack(wsId, folderId, s, d));
  }, [wsId, folderId]);
  return (
    <Drawer open={open} onClose={onClose} side={phone ? "bottom" : "right"} width={480} title="Analytics settings"
      description={<>Defaults for the items in <span className="ph-sensitive ph-mask">{folderName}</span> and the folders inside it. An item&apos;s own settings still win.</>}>
      {open && load && put ? <LevelEditor load={load} put={put} canEdit={canEdit} withEnforce={false} scope="items in this folder" inheritWord="Workspace's choice" /> : null}
    </Drawer>
  );
}

/* ── Several items at once (My files) ─────────────────────────────────── */

/** Pick items from a list, then give them the same analytics settings (ItemTrackDrawer, bulk). */
export function BulkTrackPicker({ items, open, onClose }: { items: { slug: string; title: string }[]; open: boolean; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [next, setNext] = useState(false);
  useEffect(() => { if (open) { setPicked(new Set()); setNext(false); } }, [open]);
  const all = items.length > 0 && picked.size === items.length;
  return (
    <>
      <Dialog open={open && !next} onClose={onClose} title="Analytics settings for several items"
        description="Choose the items, then what they collect."
        footer={(
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button disabled={!picked.size} onClick={() => setNext(true)}>Continue with {picked.size || "none"}</Button>
          </>
        )}>
        <div className="flex flex-col gap-1">
          <Checkbox label="Select all on this page" checked={all} indeterminate={picked.size > 0 && !all}
            onChange={(e) => setPicked(e.target.checked ? new Set(items.map((i) => i.slug)) : new Set())} />
          <ul className="m-0 flex max-h-[50dvh] list-none flex-col overflow-y-auto border-t border-border p-0 pt-1">
            {items.map((i) => (
              <li key={i.slug} className="py-0.5">
                <Checkbox label={<span className="ph-sensitive ph-mask">{i.title}</span>} checked={picked.has(i.slug)}
                  onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i.slug); else n.delete(i.slug); return n; })} />
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
      <ItemTrackDrawer slugs={[...picked]} open={open && next} onClose={onClose} />
    </>
  );
}

/** The share dialog's "Analytics" row: what the item collects, and a way to change it. */
export function ShareTrackRow({ slug }: { slug: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    getItemTrack(slug).then((d) => { if (live) setSummary(d.summary); }).catch(() => {});
    return () => { live = false; };
  }, [slug]);
  if (!summary) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-2">
      <span className="flex min-w-0 flex-col">
        <span className="text-body text-text">Analytics</span>
        <span className="text-caption text-text-muted">What it records about the people who open it.</span>
      </span>
      <TrackingChip summary={summary} onClick={() => setOpen(true)} />
      <ItemTrackDrawer slug={slug} open={open} onClose={() => setOpen(false)} onSaved={setSummary} />
    </div>
  );
}
