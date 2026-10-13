"use client";
/**
 * PublishSettings (REVAMP_PLAN 7.3, 7.4, 7.5, 8.2): one settings model for /new, /upload and the
 * builder's "Publish…" dialog. Pure UI: the caller owns the value, the workspaces list, the
 * validation errors and the publish call.
 *
 * Layouts:
 * - "chips" (/new desktop): an eyebrow and SettingChips in consequence order (access, encryption,
 *   password, expiry, link, destination); each opens a trapped Popover (Escape returns focus to
 *   its chip). On phones a chip opens the same panel as a bottom sheet instead.
 * - "rows" (/upload's Publish card, the builder dialog): labelled fields stacked, password and
 *   expiry side by side when there's room.
 * - "sheet" (the phone's "Publish settings" sheet): single column, 44px targets. Use
 *   `PublishSettingsSheet` for the sheet itself.
 *
 * Rules kept from the old PublishBar: signed out, "Who can open it" is a static fact with the
 * tooltip "No sign-in needed. This is how Markdrop links have always worked."; "Only me" can't be
 * combined with a workspace (each is disabled with its reason while the other is chosen); folder
 * ids belong to a workspace, so switching workspace clears the folder.
 */
import React, { useId, useRef, useState } from "react";
import { Alert, Badge, Drawer, Field, Icon, IconButton, Input, Popover, Radio, Select, Switch, Tooltip } from "@/components/ui";
import { SettingChip } from "./SettingChip";
import { DateTimePicker } from "./DateTimePicker";
import {
  defaultExpiryMoment, expiryChipLabel, expiryHint, expiryInvalid, PHONE_QUERY, slugPrefix, useIsClient, useMediaQuery,
  type PublishAccess, type PublishExpiry, type PublishField, type PublishSettingsValue, type PublishWorkspace,
} from "./publish-utils";
import s from "./publish.module.css";

export type { PublishSettingsValue, PublishField, PublishWorkspace } from "./publish-utils";

export type PublishSettingsLayout = "chips" | "rows" | "sheet";

export interface PublishSettingsProps {
  value: PublishSettingsValue;
  /** The whole next value, plus which field changed. */
  onChange: (next: PublishSettingsValue, field: PublishField) => void;
  layout?: PublishSettingsLayout;
  signedIn: boolean;
  /** Workspaces this person may publish into (members and above). The destination setting only
   *  appears when there's at least one. Pass the chosen workspace's `folders` once loaded. */
  workspaces?: PublishWorkspace[];
  /** WebCrypto available (secure context). Default true. */
  e2eSupported?: boolean;
  /** Per-field errors; they replace the hint, and in "chips" the chip turns danger. */
  errors?: Partial<Record<PublishField, string>>;
  /** The text before the slug for Personal: "markdrop.in/" (pass the actual host on artifacts). */
  hostPrefix?: string;
  disabled?: boolean;
  /** Which settings to offer, in the layout's own order. Default all; artifacts drop "encrypt". */
  fields?: PublishField[];
  /** Copy noun: "document" (default) or "page" (artifacts). */
  kind?: "document" | "page";
  /** "Who can open it" is a fixed fact instead of a choice. Default: when signed out. */
  accessLocked?: boolean;
  /** Controlled open panel ("chips" and the phone sheet). */
  openPanel?: PublishField | null;
  onOpenPanelChange?: (panel: PublishField | null) => void;
  /** "chips" eyebrow; null hides it. Default "Publish settings". */
  eyebrow?: string | null;
  slugMaxLength?: number;
  passwordMaxLength?: number;
  className?: string;
}

const ALL_FIELDS: PublishField[] = ["access", "encrypt", "password", "expires", "slug", "target"];
/** Chips: ordered by consequence (REVAMP_PLAN 7.3). */
const CHIP_ORDER: PublishField[] = ["access", "encrypt", "password", "expires", "slug", "target"];
/** Rows and sheet: the link first, then where and who (MobileCreate frame 2, Upload). */
const ROW_ORDER: PublishField[] = ["slug", "target", "access", "encrypt", "password", "expires"];

const PANEL_TITLE: Record<PublishField, string> = {
  access: "Who can open it",
  encrypt: "Encryption",
  password: "Password",
  expires: "Expires",
  slug: "Link",
  target: "Where it publishes",
};
const ACCESS_STATIC_TIP = "No sign-in needed. This is how Markdrop links have always worked.";
const EXPIRY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "1d", label: "In 1 day" },
  { value: "7d", label: "In 7 days" },
  { value: "30d", label: "In 30 days" },
  { value: "date", label: "On a date…" },
];

export function PublishSettings(props: PublishSettingsProps) {
  const {
    value, onChange, layout = "chips", signedIn, workspaces = [], e2eSupported = true, errors = {}, hostPrefix = "markdrop.in/",
    disabled, fields = ALL_FIELDS, kind = "document", accessLocked = !signedIn, openPanel, onOpenPanelChange,
    eyebrow = "Publish settings", slugMaxLength = 50, passwordMaxLength = 100, className,
  } = props;
  const isClient = useIsClient();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [innerPanel, setInnerPanel] = useState<PublishField | null>(null);
  const panel = openPanel !== undefined ? openPanel : innerPanel;
  const chipRefs = useRef<Partial<Record<PublishField, HTMLButtonElement | null>>>({});
  const setPanel = (p: PublishField | null) => {
    const was = panel;
    if (openPanel === undefined) setInnerPanel(p);
    onOpenPanelChange?.(p);
    // Escape must land back on the chip. A trapped Popover's focus guard can pull focus back into
    // the panel as it closes, and the panel then unmounts, dropping focus to <body>; after the
    // commit, a focus left nowhere goes to the chip (an outside click keeps its own target).
    if (was && !p) {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!a || a === document.body) chipRefs.current[was]?.focus();
      });
    }
  };

  const showTarget = signedIn && workspaces.length > 0;
  const visible = (f: PublishField) => fields.includes(f) && (f !== "target" || showTarget);
  const set = <K extends PublishField>(field: K, v: PublishSettingsValue[K]) => onChange({ ...value, [field]: v }, field);

  const ws = workspaces.find((w) => w.id === value.target.workspaceId) ?? null;
  const folder = ws?.folders?.find((f) => f.id === value.target.folderId) ?? null;
  const folderPath = folder?.path ?? (folder ? [folder.name] : []);
  const prefix = ws?.host ? slugPrefix(ws.host, folderPath) : hostPrefix.endsWith("/") ? hostPrefix : `${hostPrefix}/`;
  const fullPrefix = ws?.host ? [ws.host.replace(/\/+$/, ""), ...folderPath].join("/") + "/" : prefix;
  const expiryBad = isClient && expiryInvalid(value.expires);
  const invalid = (f: PublishField) => !!errors[f] || (f === "expires" && expiryBad);
  const noun = kind === "page" ? "page" : "document";

  const ctx: PanelCtx = {
    value, set, layout, disabled, signedIn, accessLocked, e2eSupported, errors, workspaces, ws, folderPath, prefix, fullPrefix,
    isClient, noun, slugMaxLength, passwordMaxLength, expiryBad,
  };

  if (layout !== "chips") {
    return (
      <div className={[s.settings, layout === "sheet" ? s.settingsSheet : s.settingsRows, className].filter(Boolean).join(" ")}>
        {ROW_ORDER.filter(visible).map((f) => {
          if (layout === "rows" && f === "password" && visible("expires")) {
            return (
              <div key="pair" className={[s.pair, typeof value.expires === "object" && s.pairStacked].filter(Boolean).join(" ")}>
                <PanelBody field="password" ctx={ctx} />
                <PanelBody field="expires" ctx={ctx} />
              </div>
            );
          }
          if (layout === "rows" && f === "expires" && visible("password")) return null;
          return <PanelBody key={f} field={f} ctx={ctx} />;
        })}
      </div>
    );
  }

  /* ── chips ── */
  const chipFor = (f: PublishField): { icon: string; label: string; value: React.ReactNode; valueText?: string; set: boolean; emphasis?: boolean; mono?: boolean } => {
    switch (f) {
      case "access": return { icon: value.access === "private" ? "lock" : "globe", label: PANEL_TITLE.access, value: value.access === "private" ? "Only me" : "Anyone with the link", set: value.access === "private" };
      case "encrypt": return { icon: "key", label: PANEL_TITLE.encrypt, value: value.encrypt ? "Encrypted" : "Encrypt", set: value.encrypt, emphasis: value.encrypt };
      case "password": return { icon: "lock", label: PANEL_TITLE.password, value: value.password ? "Password set" : "No password", set: !!value.password };
      case "expires": return { icon: "clock", label: PANEL_TITLE.expires, value: expiryChipLabel(value.expires, isClient), set: value.expires !== "never" };
      case "slug": {
        const slug = value.slug.trim();
        return slug
          ? { icon: "link", label: PANEL_TITLE.slug, mono: true, set: true, valueText: `${prefix}${slug}`,
              value: <><span className={s.chipPrefix}>{prefix}</span><span className={s.chipSlug}>{slug}</span></> }
          : { icon: "link", label: PANEL_TITLE.slug, value: "Random link", set: false };
      }
      case "target": {
        const label = ws ? (folder ? `${ws.name} / ${folder.name}` : ws.name) : "Personal";
        return { icon: "folder", label: PANEL_TITLE.target, value: <span className={s.chipTrunc}>{label}</span>, valueText: label, set: !!ws };
      }
    }
  };

  const chips = CHIP_ORDER.filter(visible);
  return (
    <div className={[s.chipsBar, className].filter(Boolean).join(" ")}>
      {eyebrow && <span className={s.chipsEyebrow} aria-hidden>{eyebrow}</span>}
      <div role="group" aria-label={eyebrow ?? "Publish settings"} className={s.chips}>
        {chips.map((f, i) => {
          const c = chipFor(f);
          if (f === "access" && accessLocked) {
            return (
              <Tooltip key={f} content={ACCESS_STATIC_TIP} focusable side="bottom">
                <SettingChip static label={c.label} value={c.value} icon={c.icon} />
              </Tooltip>
            );
          }
          const chip = <SettingChip ref={(el) => { chipRefs.current[f] = el; }} label={c.label} value={c.value} valueText={c.valueText} icon={c.icon} set={c.set} emphasis={c.emphasis} mono={c.mono} invalid={invalid(f)} disabled={disabled} />;
          if (isPhone) {
            return React.cloneElement(chip, { key: f, "aria-haspopup": "dialog", "aria-expanded": panel === f, onClick: () => setPanel(f) });
          }
          return (
            <Popover key={f} trigger={chip} trap title={<PanelHeading field={f} />} open={panel === f}
              onOpenChange={(o) => setPanel(o ? f : panel === f ? null : panel)}
              placement={i >= chips.length - 2 && chips.length > 3 ? "bottom-end" : "bottom-start"}
              width={f === "encrypt" ? 432 : 360} panelClassName={s.popPanel}>
              <PanelBody field={f} ctx={ctx} inPopover />
            </Popover>
          );
        })}
      </div>
      {isPhone && (
        <Drawer side="bottom" open={!!panel && chips.includes(panel)} onClose={() => setPanel(null)} title={panel ? PANEL_TITLE[panel] : ""}>
          {panel && <div className={[s.settings, s.settingsSheet].join(" ")}><PanelBody field={panel} ctx={{ ...ctx, layout: "sheet" }} inPopover /></div>}
        </Drawer>
      )}
    </div>
  );
}

/** The phone's "Publish settings" bottom sheet: PublishSettings in "sheet" layout plus a footer (Publish). */
export function PublishSettingsSheet({ open, onClose, footer, title = "Publish settings", ...rest }: Omit<PublishSettingsProps, "layout"> & { open: boolean; onClose: () => void; footer?: React.ReactNode; title?: string }) {
  return (
    <Drawer side="bottom" open={open} onClose={onClose} title={title} footer={footer}>
      <PublishSettings {...rest} layout="sheet" />
    </Drawer>
  );
}

/* ── Panels ────────────────────────────────────────────────────────────── */

interface PanelCtx {
  value: PublishSettingsValue;
  set: <K extends PublishField>(field: K, v: PublishSettingsValue[K]) => void;
  layout: PublishSettingsLayout;
  disabled?: boolean;
  signedIn: boolean;
  accessLocked: boolean;
  e2eSupported: boolean;
  errors: Partial<Record<PublishField, string>>;
  workspaces: PublishWorkspace[];
  ws: PublishWorkspace | null;
  folderPath: string[];
  prefix: string;
  fullPrefix: string;
  isClient: boolean;
  noun: string;
  slugMaxLength: number;
  passwordMaxLength: number;
  expiryBad: boolean;
}

function PanelHeading({ field }: { field: PublishField }) {
  if (field === "encrypt") return <span className={s.popTitle}>Encryption <Badge tone="info" size="sm" upper>E2E</Badge></span>;
  return <span className={s.popTitle}>{PANEL_TITLE[field]}</span>;
}

function PanelBody({ field, ctx, inPopover }: { field: PublishField; ctx: PanelCtx; inPopover?: boolean }) {
  switch (field) {
    case "access": return <AccessPanel ctx={ctx} inPopover={inPopover} />;
    case "encrypt": return <EncryptPanel ctx={ctx} inPopover={inPopover} />;
    case "password": return <PasswordPanel ctx={ctx} inPopover={inPopover} />;
    case "expires": return <ExpiresPanel ctx={ctx} inPopover={inPopover} />;
    case "slug": return <LinkPanel ctx={ctx} inPopover={inPopover} />;
    case "target": return <TargetPanel ctx={ctx} inPopover={inPopover} />;
  }
}

/** A visible label in rows/sheet; in a popover the popover title already names it (sr-only). */
function labelFor(field: PublishField, inPopover?: boolean) {
  return inPopover ? <span className="md-visually-hidden">{PANEL_TITLE[field]}</span> : PANEL_TITLE[field];
}

function AccessPanel({ ctx, inPopover }: { ctx: PanelCtx; inPopover?: boolean }) {
  const { value, set, accessLocked, ws, disabled, layout } = ctx;
  const uid = useId();
  if (accessLocked) {
    return (
      <div className={s.block}>
        {!inPopover && <span className="md-field__label">Who can open it</span>}
        <div className={s.staticFact}><Icon name="globe" /> Anyone with the link</div>
        <div className="md-field__hint">{ACCESS_STATIC_TIP}</div>
      </div>
    );
  }
  const options: Array<{ value: PublishAccess; label: string; description: string; reason?: string }> = [
    { value: "link", label: "Anyone with the link", description: ACCESS_STATIC_TIP },
    {
      value: "private", label: "Only me", description: "Nobody else can open it. You can add people once it's published.",
      reason: ws ? `Not with a workspace: everyone in ${ws.name} can read what's published there. Choose Personal to keep it to yourself.` : undefined,
    },
  ];
  return (
    <div className={s.block}>
      {!inPopover && <span id={`${uid}-l`} className="md-field__label">Who can open it</span>}
      <div role="radiogroup" aria-labelledby={inPopover ? undefined : `${uid}-l`} aria-label={inPopover ? "Who can open it" : undefined}
        className={["md-radiogroup", layout === "rows" && s.radioRow].filter(Boolean).join(" ")}>
        {options.map((o) => {
          const off = !!o.reason;
          return (
            <Radio key={o.value} name={`${uid}-access`} value={o.value} checked={value.access === o.value} disabled={disabled}
              aria-disabled={off || undefined} className={[s.radio, off && s.radioOff].filter(Boolean).join(" ")}
              onChange={() => { if (!off) set("access", o.value); }}
              label={o.label} description={o.reason ?? o.description} />
          );
        })}
      </div>
      <p className={s.caption}>Naming specific people, and workspace-only access, are set from Share once the {ctx.noun} exists.</p>
    </div>
  );
}

function EncryptPanel({ ctx, inPopover }: { ctx: PanelCtx; inPopover?: boolean }) {
  const { value, set, e2eSupported, disabled, prefix, layout } = ctx;
  const uid = useId();
  const descId = `${uid}-d`;
  const slug = value.slug.trim() || "random";
  return (
    <div className={[s.block, layout !== "chips" && !inPopover && s.encryptCard].filter(Boolean).join(" ")}>
      <div className={s.encryptHead}>
        <Switch checked={value.encrypt && e2eSupported} label="Encrypt in this browser" aria-describedby={descId}
          disabled={disabled}
          aria-disabled={!e2eSupported || undefined} className={!e2eSupported ? s.switchOff : undefined}
          onChange={(e) => { if (e2eSupported) set("encrypt", e.target.checked); }} />
        {!inPopover && <Badge tone="info" size="sm" upper>E2E</Badge>}
      </div>
      {e2eSupported ? (
        <p id={descId} className={s.body}>
          Your browser encrypts the title and the text before publishing. The key goes in the # part of the link, which browsers never send to a server — so only ciphertext ever reaches Markdrop.
        </p>
      ) : (
        <p id={descId} className={s.hintWarn}><Icon name="alert" /> Unavailable — this browser doesn&apos;t expose WebCrypto on an insecure connection.</p>
      )}
      {inPopover && e2eSupported && (
        <div className={s.keyDemo} aria-hidden>
          <div className={s.keyDemoCol}>
            <span className={s.keyDemoUrl}>{prefix}{slug}</span>
            <span className={s.keyDemoNote}><Icon name="globe" /> Sent to Markdrop</span>
          </div>
          <div className={s.keyDemoCol}>
            <span className={s.keyDemoKey}><Icon name="key" />#k=9fQx2LmA…</span>
            <span className={s.keyDemoNoteKey}><Icon name="eyeOff" /> Stays in your browser</span>
          </div>
        </div>
      )}
      {value.encrypt && e2eSupported && (
        <>
          <Alert tone="warning" title="The link is the key">Lose it and the document is gone — no recovery, by anyone.</Alert>
          <ul className={s.facts}>
            <li><Icon name="link" /> Anyone with the link can read it.</li>
            <li><Icon name="x" /> Google Docs export, VS Code sync and link previews switch off.</li>
          </ul>
        </>
      )}
    </div>
  );
}

function PasswordPanel({ ctx, inPopover }: { ctx: PanelCtx; inPopover?: boolean }) {
  const { value, set, disabled, errors, noun, passwordMaxLength, layout } = ctx;
  const [reveal, setReveal] = useState(false);
  return (
    <Field label={labelFor("password", inPopover)} hint={`Readers are asked for this before the ${noun} opens.`} error={errors.password}>
      <Input type={reveal ? "text" : "password"} value={value.password ?? ""} placeholder="Optional" autoComplete="new-password"
        autoCapitalize="off" spellCheck={false} maxLength={passwordMaxLength} disabled={disabled}
        wrapClassName={layout === "sheet" ? s.pwWrapLg : s.pwWrap}
        onChange={(e) => set("password", e.target.value === "" ? null : e.target.value)}
        suffix={<IconButton icon={reveal ? "eyeOff" : "eye"} label={reveal ? "Hide password" : "Show password"} aria-pressed={reveal}
          size={layout === "sheet" ? "lg" : "sm"} disabled={disabled} onClick={() => setReveal((r) => !r)} />} />
    </Field>
  );
}

function ExpiresPanel({ ctx, inPopover }: { ctx: PanelCtx; inPopover?: boolean }) {
  const { value, set, disabled, errors, isClient, expiryBad } = ctx;
  const selectValue = typeof value.expires === "string" ? value.expires : "date";
  const hint = isClient ? expiryHint(value.expires) : null;
  const err = errors.expires ?? (expiryBad && selectValue !== "date" ? hint?.text : undefined);
  const onSelect = (v: string) => {
    const next: PublishExpiry = v === "date"
      ? { at: (typeof value.expires === "object" ? new Date(value.expires.at) : defaultExpiryMoment()).toISOString() }
      : (v as PublishExpiry);
    set("expires", next);
  };
  return (
    <div className={s.block}>
      <Field label={labelFor("expires", inPopover)} hint={selectValue === "date" ? undefined : hint?.text} error={err}>
        <Select options={EXPIRY_OPTIONS} value={selectValue} disabled={disabled} onChange={(e) => onSelect(e.target.value)} />
      </Field>
      {typeof value.expires === "object" && (
        <DateTimePicker value={value.expires.at} disabled={disabled} onChange={(iso) => set("expires", { at: iso })}
          hint={errors.expires ? undefined : hint?.text} error={!!hint?.error} />
      )}
    </div>
  );
}

function LinkPanel({ ctx, inPopover }: { ctx: PanelCtx; inPopover?: boolean }) {
  const { value, set, disabled, errors, prefix, fullPrefix, slugMaxLength } = ctx;
  return (
    <Field label={labelFor("slug", inPopover)} hint="Leave blank for a short random link." error={errors.slug}>
      <Input mono textPrefix={prefix} value={value.slug} placeholder="random" maxLength={slugMaxLength} disabled={disabled}
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} title={fullPrefix !== prefix ? fullPrefix : undefined}
        onChange={(e) => set("slug", e.target.value)} />
    </Field>
  );
}

function TargetPanel({ ctx, inPopover }: { ctx: PanelCtx; inPopover?: boolean }) {
  const { value, set, disabled, errors, workspaces, ws, fullPrefix, prefix } = ctx;
  const privateChosen = value.access === "private";
  const wsOptions = [
    { value: "", label: "Personal (not in a workspace)" },
    ...workspaces.map((w) => ({ value: w.id, label: w.name, disabled: privateChosen && w.id !== value.target.workspaceId })),
  ];
  const folders = ws?.folders ?? [];
  const slug = value.slug.trim();
  return (
    <div className={s.block}>
      <Field label={labelFor("target", inPopover)} error={errors.target}
        hint={privateChosen ? "Only me documents stay personal. Choose “Anyone with the link” to publish into a workspace." : undefined}>
        <Select options={wsOptions} value={value.target.workspaceId ?? ""} disabled={disabled}
          // Folder ids belong to one workspace, so a switch clears the folder.
          onChange={(e) => set("target", { workspaceId: e.target.value || null, folderId: null })} />
      </Field>
      {ws && folders.length > 0 && (
        <Field label="Folder">
          <Select value={value.target.folderId ?? ""} disabled={disabled}
            options={[{ value: "", label: "No folder" }, ...folders.map((f) => ({ value: f.id, label: (f.path?.length ? f.path.join(" / ") : f.name) }))]}
            onChange={(e) => set("target", { workspaceId: value.target.workspaceId, folderId: e.target.value || null })} />
        </Field>
      )}
      <div className={s.preview}>
        <span className={s.previewLabel}>Will publish to</span>
        <span className={s.previewUrl}>{ws ? fullPrefix : prefix}{slug || <span className={s.previewRandom}>a short random link</span>}</span>
      </div>
      {ws && <Alert tone="info">Everyone in {ws.name} can read it; members and admins can edit it.</Alert>}
    </div>
  );
}
