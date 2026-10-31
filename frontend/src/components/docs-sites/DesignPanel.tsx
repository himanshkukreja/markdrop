"use client";

import { ReadMore } from "@/components/ReadMore";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Alert, Anchor, Badge, Button, Field, Icon, SegmentedControl, Select, Spinner, Switch, Textarea, cx, useToast } from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import { parseHex } from "@/components/tenant/branding";
import {
  FONTS, PRESETS, assetPreviewUrl, customCssProblem, docsErrorMessage, presetName, updateSite, uploadAsset,
  type Corners, type SiteTheme, type ThemeMode, type ThemePreset,
} from "@/lib/docsSites";
import { ratio } from "./format";
import { LOOKS, PREVIEW_FONTS_HREF, coloursFromImage, contrastChecks } from "./presets";
import SiteBar, { STUDIO_CHROME_H } from "./SiteBar";
import { useSite } from "./SiteContext";
import ThemePreview from "./ThemePreview";
import useLeaveGuard from "./useLeaveGuard";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function normalise(t: SiteTheme): SiteTheme {
  return {
    preset: t.preset ?? "clean",
    brand: { enabled: !!t.brand?.enabled, logo_url: t.brand?.logo_url ?? null, logo_dark_url: t.brand?.logo_dark_url ?? null, colors: t.brand?.colors ?? [], accent: t.brand?.accent ?? null, accent_dark: t.brand?.accent_dark ?? null },
    fonts: { heading: t.fonts?.heading ?? null, body: t.fonts?.body ?? null },
    mode: t.mode ?? "both",
    corners: t.corners ?? null,
    custom_css: t.custom_css ?? "",
  };
}

/** A preset's radio card with its swatch (Themes board). */
function PresetCard({ id, name, blurb, checked, onSelect, accent, disabled, group }: {
  id: ThemePreset; name: string; blurb: string; checked: boolean; onSelect: () => void; accent: string | null; disabled: boolean; group: string;
}) {
  const look = LOOKS[id];
  const l = look.light;
  return (
    <label
      className={cx(
        "flex cursor-pointer flex-col gap-2 rounded-lg bg-surface p-2.5 text-text has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-border-focus",
        checked ? "border-[1.5px] border-accent" : "border border-border hover:bg-surface-hover",
        disabled && "cursor-default",
      )}
    >
      <input type="radio" name={group} value={id} checked={checked} onChange={onSelect} disabled={disabled} className="md-visually-hidden" />
      <span aria-hidden className="flex h-[54px] gap-1 rounded-md p-1.5" style={{ background: l.bg }}>
        <span className="w-[18px] shrink-0 rounded-[3px]" style={{ background: look.sidebar ? l.line : l.bg }} />
        <span className="flex flex-1 flex-col gap-1 p-1" style={{ borderRadius: look.r, background: l.card }}>
          <span className="h-1.5 w-3/5 rounded-[2px]" style={{ background: l.text }} />
          <span className="h-1 w-[90%] rounded-[2px]" style={{ background: l.line }} />
          <span className="h-2 w-2/5 rounded-[2px]" style={{ background: accent ?? look.accent }} />
        </span>
      </span>
      <span className="text-[13px] font-semibold">{name}</span>
      <span className="text-[12px] leading-4 text-text-muted">{blurb}</span>
    </label>
  );
}

/**
 * /docs-studio/<site>/design (Themes board): six presets with a live preview, "Match my brand"
 * (logo → colours → a contrast-checked light and dark palette), fonts, colour mode, corners and
 * custom CSS. Nothing applies until "Save design"; the published site changes at the next publish.
 */
export default function DesignPanel() {
  const { site, setSite, base, isAdmin } = useSite();
  const toast = useToast();
  const uid = useId();
  const search = useLocationSearch();
  const isNew = new URLSearchParams(search).get("new") === "1";
  const saved = useMemo(() => normalise(site.settings.theme), [site.settings.theme]);
  const [theme, setTheme] = useState<SiteTheme>(saved);
  const [dark, setDark] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [picked, setPicked] = useState<{ name: string; url: string } | null>(null);
  const pickedName = picked?.name;
  const pickedFor = picked?.url;
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = !same(theme, saved);
  const locked = !isAdmin;

  useEffect(() => setTheme(saved), [saved]);

  // Fonts for the preview, once.
  useEffect(() => {
    if (document.querySelector(`link[data-docs-preview-fonts]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = PREVIEW_FONTS_HREF;
    l.dataset.docsPreviewFonts = "";
    document.head.appendChild(l);
  }, []);

  // Unsaved design: ask before leaving the page (the tab, and the studio's own links).
  const leaveGuard = useLeaveGuard(dirty && !locked, "the design");

  // Forced colour mode decides which preview makes sense.
  useEffect(() => {
    if (theme.mode === "light") setDark(false);
    if (theme.mode === "dark") setDark(true);
  }, [theme.mode]);

  const set = (patch: Partial<SiteTheme>) => setTheme((t) => ({ ...t, ...patch }));
  const setBrand = (patch: Partial<SiteTheme["brand"]>) => setTheme((t) => ({ ...t, brand: { ...t.brand, ...patch } }));
  const cssProblem = customCssProblem(theme.custom_css ?? "");
  const checks = contrastChecks(theme);
  const brandAccent = theme.brand.enabled ? theme.brand.accent || theme.brand.colors[0] || null : null;

  async function onLogo(file: File | undefined) {
    if (!file || locked) return;
    if (!file.type.startsWith("image/")) { setError("Choose an image: SVG, PNG, JPEG or WebP."); return; }
    setUploading(true);
    setError("");
    try {
      const local = URL.createObjectURL(file);
      const colours = await coloursFromImage(local).catch(() => [] as string[]);
      URL.revokeObjectURL(local);
      const { url } = await uploadAsset(site.id, file);
      setBrand({ enabled: true, logo_url: url, colors: colours.length ? colours : theme.brand.colors, accent: colours[0] ?? theme.brand.accent });
      setPicked({ name: file.name, url });
    } catch (e) {
      setError(docsErrorMessage(e, "That logo didn't upload. Try again."));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    if (locked || cssProblem) return;
    setSaving(true);
    setError("");
    try {
      const next = await updateSite(site.id, { settings: { theme: { ...theme, custom_css: theme.custom_css || null } } });
      setSite(next);
      toast.success("Design saved. It goes live with the next publish.");
    } catch (e) {
      setError(docsErrorMessage(e, "The design didn't save. Try again."));
    } finally {
      setSaving(false);
    }
  }

  const fontOptions = [{ value: "", label: "Theme default" }, ...FONTS.map((f) => ({ value: f.id, label: f.label }))];
  // Uploads are stored by content hash: name the file you picked, else just "Your logo".
  const logoName = theme.brand.logo_url ? (pickedName && pickedFor === theme.brand.logo_url ? pickedName : "Your logo") : null;

  return (
    <>
      <SiteBar
        section="design"
        status={dirty ? <Badge size="sm" tone="warning" dot>Unsaved</Badge> : null}
        actions={isAdmin ? (
          <>
            <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setTheme(saved)}>Reset</Button>
            <Button variant="primary" size="sm" loading={saving} disabled={!dirty || !!cssProblem} onClick={() => void save()}>Save design</Button>
          </>
        ) : null}
      />

      <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-wrap outline-none">
        <section aria-label="Design settings" className="flex w-full min-w-0 flex-col gap-6 border-border bg-surface p-4 sm:p-6 lg:max-w-[460px] lg:flex-[1_1_400px] lg:border-r">
          {isNew && (
            <Alert tone="info" title={`Pick a look for ${site.name}`}>
              You can change it any time. <ReadMore topic="studioThemes">About the themes</ReadMore> · <Anchor href={base} className="font-semibold text-accent-text underline">Skip to the editor</Anchor>
            </Alert>
          )}
          {locked && <Alert tone="neutral" title="Only admins change the design">You can look around; ask an admin of this workspace to change it.</Alert>}
          {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

          <fieldset className="flex flex-col gap-2.5" disabled={locked}>
            <legend className="mb-2.5 text-[15px] font-semibold text-text">Theme</legend>
            <div className="grid grid-cols-2 gap-2.5">
              {PRESETS.map((p) => (
                <PresetCard key={p.id} {...p} group={`${uid}-preset`} checked={theme.preset === p.id} onSelect={() => set({ preset: p.id })} accent={brandAccent} disabled={locked} />
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg p-4">
            <div className="flex items-center gap-2.5">
              <h2 id={`${uid}-brand`} className="flex-1 text-[15px] font-semibold text-text">Match my brand</h2>
              <Switch aria-labelledby={`${uid}-brand`} checked={theme.brand.enabled} disabled={locked} onChange={(e) => setBrand({ enabled: e.target.checked })} />
            </div>
            <div className="flex items-center gap-3">
              {theme.brand.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assetPreviewUrl(site.id, theme.brand.logo_url) ?? undefined} alt="" className="size-11 shrink-0 rounded-[10px] bg-logo-well-light object-contain p-1" />
              ) : (
                <span className="grid size-11 shrink-0 place-items-center rounded-[10px] text-[20px] font-extrabold text-white" style={{ background: brandAccent && parseHex(brandAccent) ? brandAccent : LOOKS[theme.preset].accent }} aria-hidden>
                  {site.name.charAt(0).toUpperCase()}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate font-semibold text-text" title={logoName ?? undefined}>{logoName ?? "No logo yet"}</strong>
                <span className="text-[12px] text-text-muted">
                  {!theme.brand.colors.length ? "Upload your logo and we'll pick up its colours" : theme.brand.logo_url ? "Colours found in your logo" : "Your brand colours"}
                </span>
              </div>
              <input ref={fileRef} type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" className="md-visually-hidden" tabIndex={-1} aria-hidden onChange={(e) => void onLogo(e.target.files?.[0])} />
              <Button variant="secondary" size="sm" iconLeft={uploading ? undefined : "upload"} disabled={locked || uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <><Spinner size={14} /> Uploading</> : theme.brand.logo_url ? "Replace" : "Upload logo"}
              </Button>
            </div>
            {theme.brand.colors.length > 0 && (
              <div role="radiogroup" aria-label="Brand accent colour" className="flex flex-wrap gap-2">
                {theme.brand.colors.map((hex) => {
                  const on = (theme.brand.accent || theme.brand.colors[0]) === hex;
                  return (
                    <button
                      key={hex}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={locked}
                      onClick={() => setBrand({ accent: hex, enabled: true })}
                      className="md-focus flex flex-col items-center gap-1 rounded-md text-[11px] text-text-muted"
                    >
                      <span className={cx("size-9 rounded-lg border", on ? "border-2 border-text" : "border-border")} style={{ background: hex }} />
                      <code className="font-mono">{hex}</code>
                    </button>
                  );
                })}
                <label className="flex flex-col items-center gap-1 text-[11px] text-text-muted">
                  <span className="relative grid size-9 cursor-pointer place-items-center rounded-lg border border-dashed border-border-strong text-text-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-border-focus">
                    <Icon name="plus" size={16} />
                    <input
                      type="color"
                      aria-label="Add a colour"
                      disabled={locked}
                      className="absolute inset-0 cursor-pointer opacity-0"
                      onChange={(e) => {
                        const hex = e.target.value.toLowerCase();
                        if (!theme.brand.colors.includes(hex)) setBrand({ colors: [...theme.brand.colors, hex].slice(-6), accent: hex, enabled: true });
                      }}
                    />
                  </span>
                  Add
                </label>
              </div>
            )}
            <p className="text-[13px] text-text-secondary">We build a light and a dark palette from these. Links, buttons and callouts keep readable contrast in both. <ReadMore topic="studioBrand" /></p>
            <div className="flex flex-wrap gap-1.5" aria-label="Contrast checks">
              {checks.map((c) => (
                <Badge key={c.label} tone={c.ok ? "success" : "warning"} size="sm" icon={c.ok ? "check" : "alert"}>{c.label} {ratio(c.ratio)}</Badge>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Headings font" htmlFor={`${uid}-hf`}>
              <Select value={theme.fonts.heading ?? ""} disabled={locked} options={fontOptions} onChange={(e) => set({ fonts: { ...theme.fonts, heading: e.target.value || null } })} />
            </Field>
            <Field label="Body font" htmlFor={`${uid}-bf`}>
              <Select value={theme.fonts.body ?? ""} disabled={locked} options={fontOptions} onChange={(e) => set({ fonts: { ...theme.fonts, body: e.target.value || null } })} />
            </Field>
            <Field label="Colour mode" htmlFor={`${uid}-mode`}>
              <Select
                value={theme.mode}
                disabled={locked}
                options={[{ value: "both", label: "Light and dark" }, { value: "light", label: "Light only" }, { value: "dark", label: "Dark only" }]}
                onChange={(e) => set({ mode: e.target.value as ThemeMode })}
              />
            </Field>
            <Field label="Corners" htmlFor={`${uid}-corners`}>
              <Select
                value={theme.corners ?? ""}
                disabled={locked}
                options={[{ value: "", label: "Theme default" }, { value: "sharp", label: "Sharp" }, { value: "soft", label: "Soft" }, { value: "round", label: "Round" }]}
                onChange={(e) => set({ corners: (e.target.value || null) as Corners | null })}
              />
            </Field>
          </div>

          <details className="rounded-lg border border-border px-3.5 py-3" open={!!theme.custom_css}>
            <summary className="cursor-pointer text-body-strong text-text">Custom CSS</summary>
            <div className="mt-2.5 flex flex-col gap-2">
              <Textarea
                mono
                rows={6}
                aria-label="Custom CSS"
                aria-describedby={`${uid}-css-hint`}
                invalid={!!cssProblem}
                disabled={locked}
                placeholder={".dx-callout { border-radius: 0; }\n.dx-header { backdrop-filter: blur(8px); }"}
                value={theme.custom_css ?? ""}
                onChange={(e) => set({ custom_css: e.target.value })}
                className="text-[12.5px]"
              />
              {cssProblem ? (
                <p className="flex items-center gap-1.5 text-[12px] text-danger" role="alert"><Icon name="alertCircle" size={13} /> {cssProblem}</p>
              ) : (
                <p id={`${uid}-css-hint`} className="text-[12px] text-text-muted">Applied after the theme, on the published site. Scripts aren&apos;t allowed. <ReadMore topic="studioCustomCss">What&apos;s allowed</ReadMore></p>
              )}
            </div>
          </details>
        </section>

        {/* Side by side, the preview stays in view while the settings scroll (like the editor's side panels). */}
        <section
          aria-label="Preview"
          className="flex min-w-0 flex-[999_1_600px] flex-col gap-3 p-4 sm:p-6 lg:sticky lg:top-[var(--chrome)] lg:max-h-[calc(100dvh-var(--chrome))] lg:self-start lg:overflow-y-auto"
          style={{ "--chrome": `${STUDIO_CHROME_H}px` } as CSSProperties}
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <strong className="flex-1 text-text">Preview · {presetName(theme.preset)}</strong>
            <SegmentedControl
              aria-label="Preview colour mode"
              size="sm"
              value={dark ? "dark" : "light"}
              onChange={(v) => setDark(v === "dark")}
              options={[
                { value: "light", label: "Light", disabled: theme.mode === "dark" },
                { value: "dark", label: "Dark", disabled: theme.mode === "light" },
              ]}
            />
          </div>
          <ThemePreview theme={theme} dark={dark} name={site.name} logo={theme.brand.enabled ? assetPreviewUrl(site.id, theme.brand.logo_url) : null} />
          {dirty && isAdmin && <p className="text-[13px] text-text-muted">Not saved yet. Readers see the new design after you save it and publish.</p>}
        </section>
      </main>
      {leaveGuard}
    </>
  );
}
