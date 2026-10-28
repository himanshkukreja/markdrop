"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button, Card, Disclosure, Field, Input, RadioGroup, SegmentedControl, Skeleton, ThemeScope, useToast,
} from "@/components/ui";
import { BrowserFrame } from "@/components/kit/BrowserFrame";
import AssetUpload from "@/components/workspace/AssetUpload";
import ColorPicker from "@/components/workspace/ColorPicker";
import { BrandTile, wellOf, type BrandingWithWell, type LogoWell } from "@/components/workspace/BrandTile";
import { accentTokens } from "@/components/tenant/branding";
import { updateWorkspace, uploadBrandingAsset, type ViewerChrome } from "@/lib/workspaces";
import { SwitchRow } from "../../../settings-shared";
import { Locked, type WsTabProps } from "../ws-shared";
import DomainsCard from "./DomainsCard";
import styles from "../workspace.module.css";

interface Draft {
  name: string;
  site_name: string;
  accent_color: string | null;
  hide_markdrop_branding: boolean;
  logo_well: LogoWell;
  viewer_chrome: ViewerChrome;
}

function draftOf(name: string, b: BrandingWithWell, chrome: ViewerChrome): Draft {
  return {
    name,
    site_name: b.site_name ?? "",
    accent_color: b.accent_color ?? null,
    hide_markdrop_branding: !!b.hide_markdrop_branding,
    logo_well: wellOf(b.logo_well),
    // D24: "minimal" is no longer offered; it behaves like Full, so it shows as Full.
    viewer_chrome: chrome === "none" ? "none" : "full",
  };
}

const WELL_OPTIONS: Array<{ value: "auto" | "light" | "dark" | "checker"; label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "checker", label: "Checker" },
];

/**
 * Look and domain (Settings board): the workspace's name and the site name its pages carry, its own
 * domain(s), then logo, colours and favicon with a preview. A sticky save bar appears only while
 * there are unsaved changes. Uploads (favicon, logo) and their removal save at once and never count
 * as unsaved changes: the upload is stored the moment it lands, so it is written onto the workspace
 * straight away too (on top of the last saved branding, never the unsaved draft).
 */
export default function LookTab(props: WsTabProps) {
  const { id, ws, isAdmin, host, setWs } = props;
  const toast = useToast();
  const saved = ws.branding as BrandingWithWell;
  const hasWellField = "logo_well" in saved; // D38: tolerate an API without the field
  const base = useMemo(() => draftOf(ws.name, saved, ws.settings.viewer_chrome), [ws.name, saved, ws.settings.viewer_chrome]);
  const [draft, setDraft] = useState<Draft>(base);
  const [saving, setSaving] = useState(false);
  const [ground, setGround] = useState<"light" | "dark">("light");
  const locked = !isAdmin;

  // A fresh server copy (after a save or an upload) updates only the fields whose saved value
  // changed, so an upload never throws away a half-typed site name.
  const prevBase = useRef(base);
  useEffect(() => {
    const prev = prevBase.current;
    prevBase.current = base;
    if (prev === base) return;
    setDraft((d) => {
      const next = { ...d };
      (Object.keys(base) as Array<keyof Draft>).forEach((k) => {
        if (prev[k] !== base[k]) (next as Record<keyof Draft, unknown>)[k] = base[k];
      });
      return next;
    });
  }, [base]);

  const nameChanged = draft.name.trim() !== base.name.trim();
  const dirty =
    nameChanged ||
    draft.site_name.trim() !== base.site_name.trim() ||
    (draft.accent_color || null) !== (base.accent_color || null) ||
    draft.hide_markdrop_branding !== base.hide_markdrop_branding ||
    draft.logo_well !== base.logo_well ||
    draft.viewer_chrome !== base.viewer_chrome;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => !locked && setDraft((d) => ({ ...d, [k]: v }));

  async function save() {
    if (!draft.name.trim()) { toast.error("Give the workspace a name."); return; }
    setSaving(true);
    try {
      const branding: BrandingWithWell = {
        ...saved,
        site_name: draft.site_name.trim() || null,
        accent_color: draft.accent_color,
        hide_markdrop_branding: draft.hide_markdrop_branding,
        ...(hasWellField ? { logo_well: draft.logo_well } : null),
      };
      const settings = {
        ...ws.settings,
        // Untouched legacy "minimal" stays as stored.
        viewer_chrome: draft.viewer_chrome === base.viewer_chrome ? ws.settings.viewer_chrome : draft.viewer_chrome,
      };
      setWs(await updateWorkspace(id, { ...(nameChanged ? { name: draft.name.trim() } : null), branding, settings }));
      toast.success("Saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the brand. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function saveAsset(kind: "favicon_url" | "logo_url", url: string | null) {
    const w = await updateWorkspace(id, { branding: { ...saved, [kind]: url } });
    setWs(w);
    toast.success(kind === "logo_url" ? (url ? "Logo saved." : "Logo removed.") : url ? "Favicon saved." : "Favicon removed.");
  }

  const preview = (
    <BrandPreview
      draft={draft}
      faviconUrl={saved.favicon_url}
      logoUrl={saved.logo_url}
      host={host}
      fallbackName={ws.name}
      ground={ground}
      onGround={setGround}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section aria-label="Names" className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4 rounded-xl border border-border bg-surface p-5">
        <Field label="Workspace name">
          <Input
            value={draft.name}
            maxLength={80}
            readOnly={locked}
            aria-disabled={locked || undefined}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label="Site name on your pages" hint="Shown in the header and link previews.">
          <Input
            placeholder={`e.g. ${ws.name}`}
            maxLength={60}
            value={draft.site_name}
            readOnly={locked}
            aria-disabled={locked || undefined}
            onChange={(e) => set("site_name", e.target.value)}
          />
        </Field>
      </section>

      <DomainsCard {...props} />

      {/* Phones and narrow windows: the preview sits above the form, collapsed. */}
      <div className="xl:hidden">
        <Disclosure
          summary="Preview: how your links look"
          className="rounded-xl border border-border bg-surface"
          buttonClassName="w-full px-4 py-3 text-body-strong"
          panelClassName="px-4 pb-4"
        >
          {preview}
        </Disclosure>
      </div>

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card title="Logo, colours and favicon" description="On your own domains: page titles, the favicon and link preview cards. Anything left blank falls back to Markdrop's.">
            <div className="flex min-w-0 flex-col gap-5">
              <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <AssetUpload
                  label="Favicon"
                  hint="PNG, JPEG, WebP or GIF, under 2 MB. Resized to 128px. Saved at once."
                  value={saved.favicon_url}
                  locked={locked}
                  onUpload={async (file) => saveAsset("favicon_url", await uploadBrandingAsset(id, "favicon", file))}
                  onClear={() => saveAsset("favicon_url", null)}
                />
                <AssetUpload
                  label="Logo"
                  hint="Shown on link preview cards and your domain's header. Saved at once."
                  shape="wide"
                  well={draft.logo_well}
                  value={saved.logo_url}
                  locked={locked}
                  onUpload={async (file) => saveAsset("logo_url", await uploadBrandingAsset(id, "logo", file))}
                  onClear={() => saveAsset("logo_url", null)}
                />
              </div>

              {hasWellField && (
                <div className="flex min-w-0 flex-col gap-2">
                  <span id="ws-well-label" className="md-field__label">Logo background</span>
                  <Locked locked={locked}>
                    <SegmentedControl
                      aria-labelledby="ws-well-label"
                      aria-describedby="ws-well-hint"
                      value={draft.logo_well ?? "auto"}
                      onChange={(v) => set("logo_well", v === "auto" ? null : (v as LogoWell))}
                      options={WELL_OPTIONS}
                      disabled={locked}
                      size="sm"
                      className="max-w-full self-start overflow-x-auto"
                    />
                  </Locked>
                  <p id="ws-well-hint" className="md-field__hint">
                    The ground behind your logo. Automatic follows the reader&apos;s theme; pick Light for a dark logo, Dark for a light one.
                  </p>
                </div>
              )}

              <ColorPicker value={draft.accent_color} locked={locked} onChange={(hex) => set("accent_color", hex)} />

              <Locked locked={locked}>
                <div>
                  <SwitchRow
                    id="ws-whitelabel"
                    label="White-label preview cards"
                    hint={'Removes "Published with Markdrop" from cards and titles.'}
                    checked={draft.hide_markdrop_branding}
                    locked={locked}
                    onChange={(on) => set("hide_markdrop_branding", on)}
                  />
                </div>
              </Locked>
            </div>
          </Card>

          <Card title="Viewer" description="Only ever applies on your own verified domains, never on markdrop.in, where we stay accountable for what's served.">
            <Locked locked={locked}>
              <div>
                <RadioGroup
                  name="ws-viewer-chrome"
                  aria-label="Viewer controls"
                  value={draft.viewer_chrome}
                  onChange={(v) => set("viewer_chrome", v as ViewerChrome)}
                  options={[
                    { value: "full", label: "Full", description: "Visitors can leave full screen and see document details.", disabled: locked },
                    { value: "none", label: "View only", description: "No controls for signed-out visitors. The page is the document and nothing else.", disabled: locked },
                  ]}
                />
              </div>
            </Locked>
          </Card>
        </div>

        <div className="hidden min-w-0 xl:sticky xl:top-20 xl:block">
          <Card title="How your links look" description="Updates as you edit.">{preview}</Card>
        </div>
      </div>

      {dirty && !locked && (
        <div className={`${styles.saveBar} flex min-w-0 flex-wrap items-center justify-between gap-3`} role="region" aria-label="Unsaved changes">
          <p className="text-body-strong text-text" aria-live="polite">You have unsaved changes</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setDraft(base)} disabled={saving}>Discard</Button>
            <Button variant="primary" onClick={save} loading={saving}>Save changes</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The two places people judge a branded link: the browser tab on your domain, and the card that
 * unfurls in Slack or LinkedIn. Drawn on a light or dark ground (the reader's theme), so the logo
 * is checked on both wells (D38).
 */
function BrandPreview({
  draft, faviconUrl, logoUrl, host, fallbackName, ground, onGround,
}: {
  draft: Draft;
  faviconUrl: string | null;
  logoUrl: string | null;
  host: string | null;
  fallbackName: string;
  ground: "light" | "dark";
  onGround: (g: "light" | "dark") => void;
}) {
  const name = draft.site_name.trim() || "Markdrop";
  const domain = host || "markdrop.in";
  const t = accentTokens(draft.accent_color);
  // Customer accent, already contrast-clamped per theme by the tenant maths.
  const vars = t
    ? ({ "--accent": t.accent, "--accent-hover": t.accentHover, "--on-accent": t.onAccent, "--accent-text": t.text[ground].base } as React.CSSProperties)
    : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span id="ws-ground" className="text-eyebrow uppercase text-text-muted">Reader&apos;s theme</span>
        <SegmentedControl
          aria-labelledby="ws-ground"
          size="sm"
          value={ground}
          onChange={(v) => onGround(v as "light" | "dark")}
          options={[{ value: "light", label: "Light", icon: "sun" }, { value: "dark", label: "Dark", icon: "moon" }]}
        />
      </div>

      <ThemeScope theme={ground} className="flex min-w-0 flex-col gap-4 rounded-lg p-3" style={vars}>
        <BrowserFrame
          size="sm"
          title={<span className="truncate">Quarterly plan · {name}</span>}
          favicon={<BrandTile name={name} logoUrl={faviconUrl} accent={draft.accent_color} size={14} />}
          url={{ host: domain, slug: "quarterly-plan" }}
          urlIcon="lock"
          aria-label={`Preview of a document on ${domain}`}
          role="img"
          bodyClassName="p-3"
        >
          <div className="flex flex-col gap-2.5" aria-hidden>
            <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
              <span className="flex min-w-0 items-center gap-2">
                {logoUrl ? (
                  <BrandTile name={name} logoUrl={logoUrl} logoWell={draft.logo_well} size={24} />
                ) : (
                  <BrandTile name={name || fallbackName} accent={draft.accent_color} size={20} />
                )}
                <span className="truncate text-caption font-semibold text-text">{name}</span>
              </span>
              <span className="rounded-md bg-accent px-2 py-1 text-micro font-semibold text-on-accent">Copy link</span>
            </div>
            <p className="text-micro font-semibold uppercase tracking-wide text-accent-text">Guides</p>
            <p className="text-body-strong text-text">Quarterly plan</p>
            <Skeleton width="90%" height={6} />
            <Skeleton width="72%" height={6} />
          </div>
        </BrowserFrame>

        <div className="flex min-w-0 overflow-hidden rounded-lg border border-border bg-surface" role="img" aria-label="Preview of the shared link card">
          <div className="min-w-0 flex-1 p-3" aria-hidden>
            <p className="truncate font-mono text-micro text-text-muted">{domain}</p>
            <p className="mt-0.5 truncate text-caption font-semibold text-accent-text">Quarterly plan</p>
            <p className="mt-0.5 line-clamp-2 text-micro text-text-secondary">Revenue, headcount and roadmap for the next quarter.</p>
            {!draft.hide_markdrop_branding && <p className="mt-1.5 text-micro text-text-muted">Published with Markdrop</p>}
          </div>
          <div className="grid w-24 shrink-0 place-items-center bg-accent p-2" aria-hidden>
            {logoUrl ? (
              <BrandTile name={name} logoUrl={logoUrl} logoWell={draft.logo_well} size={44} />
            ) : (
              <span className="text-center text-micro font-semibold text-on-accent">{name}</span>
            )}
          </div>
        </div>
      </ThemeScope>
    </div>
  );
}
