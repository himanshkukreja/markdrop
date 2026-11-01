"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Dialog, Field, Icon, IconButton, Input, SegmentedControl, Select, Tabs, Textarea, Tooltip, cx } from "@/components/ui";
import { CUSTOM_RANGES, contrastGuard, resolveTheme, type GuardRow } from "@/docs/theme.mjs";
import { FONTS, PRESETS, customCssProblem, presetName, type SiteTheme, type ThemeMode, type ThemePreset } from "@/lib/docsSites";
import { COLOR_KEYS, engineTheme, type CustomColorApiKey, type CustomThemeSettings } from "@/lib/guideThemes";
import { LOOKS } from "../presets";
import { Choice, ColorField, Group, OptionCards, SectionHead, SliderField, TriState } from "./controls";
import { LivePreview } from "./LivePreview";
import { CURATED, effectiveColors, getColor, getCustom, paletteFrom, presetType, withColor, withColors, withCustom, type Mode } from "./model";

type Section = "colors" | "type" | "shape" | "layout" | "icons" | "advanced";
const SECTIONS: Array<{ value: Section; label: string; icon: string }> = [
  { value: "colors", label: "Colours", icon: "palette" },
  { value: "type", label: "Typography", icon: "type" },
  { value: "shape", label: "Shape", icon: "square" },
  { value: "layout", label: "Layout", icon: "columns" },
  { value: "icons", label: "Icons", icon: "sparkle" },
  { value: "advanced", label: "Advanced", icon: "code" },
];

const COLOR_LABEL: Record<CustomColorApiKey, string> = {
  bg: "Page background", surface: "Cards and panels", sidebar: "Sidebar", header: "Header", border: "Borders",
  text: "Text", muted: "Muted text", accent: "Accent (links, buttons)",
  code_bg: "Code background", code_text: "Code text",
  note: "Note", tip: "Tip", warning: "Warning", danger: "Danger", selection: "Text selection",
};
const COLOR_GROUPS: Array<{ label: string; keys: CustomColorApiKey[] }> = [
  { label: "Surfaces", keys: ["bg", "surface", "sidebar", "header", "border"] },
  { label: "Text and accent", keys: ["text", "muted", "accent", "selection"] },
  { label: "Code blocks", keys: ["code_bg", "code_text"] },
  { label: "Callouts", keys: ["note", "tip", "warning", "danger"] },
];
const apiKey = (k: GuardRow["key"]) => COLOR_KEYS.find((c) => c.key === k)?.api ?? "text";

/** Every custom setting each section owns, for "Reset". */
const SECTION_KEYS: Record<Exclude<Section, "colors" | "advanced">, Array<keyof CustomThemeSettings>> = {
  type: ["base_size", "line_height", "heading_weight", "content_width"],
  shape: ["radius", "buttons", "cards"],
  layout: ["header_align", "header_style", "section_tabs", "tab_style", "sidebar_style", "sidebar_icons", "callouts", "code_theme", "links"],
  icons: ["icons"],
};

/** Undo / redo over the builder's edits; rapid edits to one control (a slider drag) are one step. */
function useHistory(theme: SiteTheme, onChange: (t: SiteTheme) => void) {
  const h = useRef({ past: [] as SiteTheme[], future: [] as SiteTheme[], key: null as string | null, at: 0 });
  const current = useRef(theme);
  current.current = theme;
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const apply = useCallback((next: SiteTheme, key?: string) => {
    const s = h.current;
    const now = Date.now();
    if (!(key && key === s.key && now - s.at < 900)) {
      s.past.push(current.current);
      if (s.past.length > 200) s.past.shift();
    }
    s.future = [];
    s.key = key ?? null;
    s.at = now;
    onChange(next);
    bump();
  }, [onChange]);
  const undo = useCallback(() => {
    const s = h.current;
    const prev = s.past.pop();
    if (!prev) return;
    s.future.push(current.current);
    s.key = null;
    onChange(prev);
    bump();
  }, [onChange]);
  const redo = useCallback(() => {
    const s = h.current;
    const next = s.future.pop();
    if (!next) return;
    s.past.push(current.current);
    s.key = null;
    onChange(next);
    bump();
  }, [onChange]);
  return { apply, undo, redo, canUndo: h.current.past.length > 0, canRedo: h.current.future.length > 0 };
}

/** A tiny drawing of a choice, in the studio's own tokens. */
const Draw = {
  radius: (r: number) => <span className="block h-6 w-9 border-2 border-text-secondary bg-surface" style={{ borderRadius: r }} />,
  button: (r: string) => <span className="block h-[18px] w-11 bg-accent" style={{ borderRadius: r }} />,
  card: (kind: "flat" | "bordered" | "raised") => (
    <span className={cx("block h-6 w-10 rounded-[5px] bg-surface", kind === "flat" && "bg-surface-active", kind === "bordered" && "border border-border-strong", kind === "raised" && "border border-border shadow-md")} />
  ),
  lines: (kind: "pills" | "lines" | "plain") => (
    <span className="flex w-12 flex-col gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span key={i} className={cx("block h-[5px]", i === 1 ? (kind === "pills" ? "rounded-full bg-accent/60" : kind === "lines" ? "border-l-2 border-accent bg-text-muted/30" : "bg-accent") : kind === "lines" ? "border-l border-border-strong bg-text-muted/25" : "rounded-full bg-text-muted/25")} />
      ))}
    </span>
  ),
  callout: (kind: "tinted" | "bordered" | "bar") => (
    <span className={cx("block h-5 w-12", kind === "tinted" && "rounded-[4px] bg-accent/25", kind === "bordered" && "rounded-[4px] border border-accent", kind === "bar" && "border-l-[3px] border-accent bg-accent/20")} />
  ),
  code: (kind: "auto" | "light" | "dark") => (
    <span className={cx("flex h-5 w-12 flex-col justify-center gap-[3px] rounded-[4px] px-1.5", kind === "dark" ? "bg-[#0d1117]" : kind === "light" ? "border border-border bg-[#f6f8fa]" : "bg-surface-active")}>
      <span className={cx("block h-[3px] w-6 rounded-full", kind === "dark" ? "bg-[#ff7b72]" : "bg-[#c11f2b]/70")} />
      <span className={cx("block h-[3px] w-8 rounded-full", kind === "dark" ? "bg-[#a5d6ff]" : "bg-[#0a3069]/60")} />
    </span>
  ),
  link: (kind: "underline" | "accent" | "plain") => (
    <span className={cx("text-[12px] text-accent-text", kind === "underline" && "underline underline-offset-2", kind === "plain" && "font-bold")}>Link</span>
  ),
  header: (kind: "left" | "center" | "solid" | "transparent") => (
    <span className={cx("flex h-5 w-14 items-center gap-1 rounded-[3px] px-1", kind === "transparent" ? "border border-dashed border-border-strong" : "bg-surface-active", kind === "center" && "justify-center")}>
      <span className="block size-2 rounded-[2px] bg-accent" />
      <span className="block h-[3px] w-5 rounded-full bg-text-muted/50" />
    </span>
  ),
  tabs: (kind: "pills" | "underline") => (
    <span className="flex items-end gap-1">
      <span className={cx("block h-[10px] w-5", kind === "pills" ? "rounded-full bg-text-muted/35" : "border-b-2 border-accent")} />
      <span className="block h-[4px] w-5 rounded-full bg-text-muted/25" />
    </span>
  ),
};

const ICON_SAMPLE = ["doc", "bulb", "folder", "info", "zap"];
function IconRow({ style }: { style: "regular" | "light" | "bold" | "duotone" }) {
  const stroke = style === "light" ? 1.35 : style === "bold" ? 2.4 : 1.8;
  return (
    <span className="flex items-center gap-2 text-accent-text">
      {ICON_SAMPLE.map((n) => (
        <Icon key={n} name={n} size={18} style={{ strokeWidth: stroke, ...(style === "duotone" ? { fill: "currentColor", fillOpacity: 0.2 } : {}) }} />
      ))}
    </span>
  );
}

export interface ThemeBuilderProps {
  siteName: string;
  theme: SiteTheme;
  onChange: (t: SiteTheme) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
  saving: boolean;
  dirty: boolean;
  logo: string | null;
  /** The guide's brand colours (Match my brand): suggested palettes. */
  brandColors: string[];
  /** Save the design as a template (null: not allowed here). */
  onSaveTemplate: ((name: string) => Promise<void>) | null;
}

/**
 * The theme builder (Design → Customize): every part of a guide's look, live. Left, the controls in
 * sections; right, the guide itself (LivePreview: the engine's own pages and stylesheet), light or
 * dark, desktop or phone, home or an article. Edits go straight into the Design panel's draft, so
 * closing keeps them; "Save design" saves (then Publish puts it live).
 */
export default function ThemeBuilder({ siteName, theme, onChange, onClose, onSave, saving, dirty, logo, brandColors, onSaveTemplate }: ThemeBuilderProps) {
  const uid = useId();
  const [section, setSection] = useState<Section>("colors");
  const [mode, setMode] = useState<Mode>(theme.mode === "dark" ? "dark" : "light");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [page, setPage] = useState<"home" | "article">("article");
  const [pane, setPane] = useState<"controls" | "preview">("controls");
  const [naming, setNaming] = useState(false);
  const { apply, undo, redo, canUndo, canRedo } = useHistory(theme, onChange);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (theme.mode === "light") setMode("light");
    if (theme.mode === "dark") setMode("dark");
  }, [theme.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).type === "text"))) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const eff = useMemo(() => effectiveColors(theme), [theme]);
  const guard = useMemo(() => {
    const { theme: t, brand } = engineTheme(theme);
    return contrastGuard(t, brand);
  }, [theme]);
  const failing = guard.filter((r) => !r.ok && r.set);
  const failingHere = failing.filter((r) => r.mode === mode);
  const cssProblem = customCssProblem(theme.custom_css ?? "");
  const type = presetType(theme.preset);
  const set = (k: keyof CustomThemeSettings, v: unknown) => apply(withCustom(theme, { [k]: v } as Partial<CustomThemeSettings>), `c:${String(k)}`);
  const c = <K extends Exclude<keyof CustomThemeSettings, "light" | "dark">>(k: K) => getCustom(theme, k);
  const fix = (rows: GuardRow[]) => {
    let next = theme;
    for (const r of rows) if (r.fix) next = withColor(next, r.mode, apiKey(r.key), r.fix);
    apply(next);
  };
  const warningFor = (k: CustomColorApiKey) => {
    const row = failingHere.find((r) => apiKey(r.key) === k && (k !== "accent" || r.label === "Links"));
    return row ? { ratio: row.ratio, onFix: () => fix([row]) } : null;
  };
  const resetSection = (s: Section) => {
    if (s === "colors") apply(withCustom(theme, { light: null, dark: null }));
    else if (s === "advanced") apply({ ...theme, custom_css: "" });
    else if (s === "type") apply({ ...withCustom(theme, Object.fromEntries(SECTION_KEYS.type.map((k) => [k, null]))), fonts: { heading: null, body: null, mono: null } });
    else apply(withCustom(theme, Object.fromEntries(SECTION_KEYS[s].map((k) => [k, null]))));
  };
  const sectionDirty = (s: Section): boolean => {
    if (s === "colors") return [theme.custom?.light, theme.custom?.dark].some((m) => !!m && Object.values(m).some(Boolean));
    if (s === "advanced") return !!theme.custom_css;
    if (s === "type") return SECTION_KEYS.type.some((k) => theme.custom?.[k] != null) || !!(theme.fonts.heading || theme.fonts.body || theme.fonts.mono);
    return SECTION_KEYS[s].some((k) => theme.custom?.[k] != null);
  };
  const fontOpts = (kinds: string[], current: string) => [
    { value: "", label: `Theme default (${FONTS.find((f) => f.id === current)?.label ?? current})` },
    ...FONTS.filter((f) => kinds.includes(f.kind)).map((f) => ({ value: f.id, label: `${f.label}${f.kind === "serif" ? " · serif" : f.kind === "mono" ? " · mono" : ""}` })),
  ];
  // The preset's own fonts (what "Theme default" means), from the engine.
  const presetFonts = useMemo(() => {
    const { theme: t, brand } = engineTheme({ ...theme, fonts: {} });
    return (Object.assign({ heading: "manrope", body: "manrope", mono: "jetbrains-mono" }, (resolveFonts(t, brand))));
  }, [theme]);

  const brandPalettes = brandColors.slice(0, 4);

  let body: ReactNode = null;
  if (section === "colors") {
    body = (
      <>
        <SectionHead title="Colours" hint="Each colour is set for light and dark separately. Unset colours follow the theme." onReset={() => resetSection("colors")} canReset={sectionDirty("colors")} />
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1 text-[13px] font-medium text-text">Editing</span>
          <SegmentedControl
            aria-label="Colours for"
            size="sm"
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            options={[
              { value: "light", label: "Light", icon: "sun", disabled: theme.mode === "dark" },
              { value: "dark", label: "Dark", icon: "moon", disabled: theme.mode === "light" },
            ]}
          />
        </div>
        <Choice
          label="Colour mode"
          defaultLabel="Both"
          value={theme.mode === "both" ? null : theme.mode}
          onChange={(v) => apply({ ...theme, mode: (v ?? "both") as ThemeMode })}
          options={[{ value: "light", label: "Light only" }, { value: "dark", label: "Dark only" }]}
        />
        {failing.length > 0 && (
          <Alert tone="warning" title={failing.length === 1 ? "1 colour pair is hard to read" : `${failing.length} colour pairs are hard to read`}>
            <ul className="mt-1 flex flex-col gap-1">
              {failing.map((r) => (
                <li key={`${r.mode}-${r.label}`} className="flex items-center gap-2 text-[12.5px]">
                  <span className="inline-flex size-4 shrink-0 rounded-sm border border-border" style={{ background: r.bg }}>
                    <span className="m-auto block size-2 rounded-full" style={{ background: r.fg }} />
                  </span>
                  <span className="min-w-0 flex-1 text-text-secondary">
                    {r.label} <span className="text-text-muted">({r.mode})</span> · {r.ratio.toFixed(2)}:1
                  </span>
                  <button type="button" className="md-focus rounded font-semibold text-accent-text underline" onClick={() => fix([r])}>Fix</button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-text-muted">WCAG AA asks for 4.5:1. Until you fix them, readers get the nearest readable shade automatically.</p>
            <Button className="mt-2" size="sm" variant="secondary" iconLeft="check" onClick={() => fix(failing)}>Fix all</Button>
          </Alert>
        )}
        <Group label="Suggested palettes">
          <div className="flex flex-wrap gap-2">
            {brandPalettes.map((hex) => (
              <PaletteChip key={`b-${hex}`} label="From your logo" accent={hex} onPick={() => apply(withColors(theme, paletteFrom(hex)))} />
            ))}
            {CURATED.map((p) => (
              <PaletteChip key={p.id} label={p.name} accent={p.accent} warm={p.warm} onPick={() => apply(withColors(theme, paletteFrom(p.accent, { warm: p.warm })))} />
            ))}
          </div>
          {!brandPalettes.length && <p className="text-[12px] text-text-muted">Turn on Match my brand and upload your logo to get palettes from its colours.</p>}
        </Group>
        {COLOR_GROUPS.map((g) => (
          <Group key={g.label} label={g.label}>
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface px-3">
              {g.keys.map((k) => (
                <ColorField
                  key={`${mode}-${k}`}
                  label={COLOR_LABEL[k]}
                  value={getColor(theme, mode, k)}
                  fallback={eff[mode][k]}
                  warning={warningFor(k)}
                  onChange={(hex) => apply(withColor(theme, mode, k, hex), `color:${mode}:${k}`)}
                />
              ))}
            </div>
          </Group>
        ))}
      </>
    );
  } else if (section === "type") {
    body = (
      <>
        <SectionHead title="Typography" hint="Fonts are served from the guide itself; readers' browsers never ask a third party." onReset={() => resetSection("type")} canReset={sectionDirty("type")} />
        <div className="grid grid-cols-1 gap-3">
          <Field label="Headings">
            <Select value={theme.fonts.heading ?? ""} options={fontOpts(["sans", "serif", "mono"], presetFonts.heading)} onChange={(e) => apply({ ...theme, fonts: { ...theme.fonts, heading: e.target.value || null } })} />
          </Field>
          <Field label="Body text">
            <Select value={theme.fonts.body ?? ""} options={fontOpts(["sans", "serif"], presetFonts.body)} onChange={(e) => apply({ ...theme, fonts: { ...theme.fonts, body: e.target.value || null } })} />
          </Field>
          <Field label="Code">
            <Select value={theme.fonts.mono ?? ""} options={fontOpts(["mono"], presetFonts.mono)} onChange={(e) => apply({ ...theme, fonts: { ...theme.fonts, mono: e.target.value || null } })} />
          </Field>
        </div>
        <SliderField label="Text size" unit="px" value={c("base_size")} fallback={type.size} min={CUSTOM_RANGES.baseSize[0]} max={CUSTOM_RANGES.baseSize[1]} step={CUSTOM_RANGES.baseSize[2]} onChange={(v) => set("base_size", v)} />
        <SliderField label="Line height" value={c("line_height")} fallback={type.line} min={CUSTOM_RANGES.lineHeight[0]} max={CUSTOM_RANGES.lineHeight[1]} step={CUSTOM_RANGES.lineHeight[2]} format={(n) => n.toFixed(2)} onChange={(v) => set("line_height", v === null ? null : Math.round(v * 100) / 100)} />
        <SliderField label="Heading weight" value={c("heading_weight")} fallback={LOOKS[theme.preset]?.headW ?? 700} min={400} max={900} step={100} onChange={(v) => set("heading_weight", v)} />
        <SliderField label="Content width" unit="px" value={c("content_width")} fallback={type.width} min={CUSTOM_RANGES.contentWidth[0]} max={CUSTOM_RANGES.contentWidth[1]} step={CUSTOM_RANGES.contentWidth[2]} onChange={(v) => set("content_width", v)} />
      </>
    );
  } else if (section === "shape") {
    body = (
      <>
        <SectionHead title="Shape" hint="Corners, buttons and cards. Unset follows the theme." onReset={() => resetSection("shape")} canReset={sectionDirty("shape")} />
        <Group label="Corner radius">
          <OptionCards
            label="Corner radius"
            columns={5}
            value={c("radius")}
            onChange={(v) => set("radius", v)}
            options={[
              { value: "none", label: "None", draw: Draw.radius(0) },
              { value: "small", label: "Small", draw: Draw.radius(3) },
              { value: "medium", label: "Medium", draw: Draw.radius(6) },
              { value: "large", label: "Large", draw: Draw.radius(10) },
              { value: "xlarge", label: "Extra", draw: Draw.radius(14) },
            ]}
          />
        </Group>
        <Group label="Buttons and search">
          <OptionCards label="Button shape" value={c("buttons")} onChange={(v) => set("buttons", v)} options={[
            { value: "square", label: "Square", draw: Draw.button("2px") },
            { value: "rounded", label: "Rounded", draw: Draw.button("6px") },
            { value: "pill", label: "Pill", draw: Draw.button("999px") },
          ]} />
        </Group>
        <Group label="Cards">
          <OptionCards label="Card style" value={c("cards")} onChange={(v) => set("cards", v)} options={[
            { value: "flat", label: "Flat", draw: Draw.card("flat") },
            { value: "bordered", label: "Bordered", draw: Draw.card("bordered") },
            { value: "raised", label: "Raised", draw: Draw.card("raised") },
          ]} />
        </Group>
      </>
    );
  } else if (section === "layout") {
    body = (
      <>
        <SectionHead title="Layout" hint="The header, sidebar and the pieces inside a page." onReset={() => resetSection("layout")} canReset={sectionDirty("layout")} />
        <Group label="Header">
          <OptionCards label="Header alignment" columns={2} value={c("header_align")} onChange={(v) => set("header_align", v)} options={[
            { value: "left", label: "Left", draw: Draw.header("left") },
            { value: "center", label: "Centred", draw: Draw.header("center") },
          ]} />
          <OptionCards label="Header style" columns={2} value={c("header_style")} onChange={(v) => set("header_style", v)} options={[
            { value: "solid", label: "Solid", draw: Draw.header("solid") },
            { value: "transparent", label: "Transparent", draw: Draw.header("transparent") },
          ]} />
          <TriState label="Sections as header tabs" yes="On" no="Off" value={c("section_tabs")} onChange={(v) => set("section_tabs", v)} />
        </Group>
        <Group label="Navigation tabs">
          <OptionCards label="Tab style" columns={2} value={c("tab_style")} onChange={(v) => set("tab_style", v)} options={[
            { value: "pills", label: "Pills", draw: Draw.tabs("pills") },
            { value: "underline", label: "Underline", draw: Draw.tabs("underline") },
          ]} />
        </Group>
        <Group label="Sidebar">
          <OptionCards label="Sidebar style" value={c("sidebar_style")} onChange={(v) => set("sidebar_style", v)} options={[
            { value: "pills", label: "Pills", draw: Draw.lines("pills") },
            { value: "lines", label: "Lines", draw: Draw.lines("lines") },
            { value: "plain", label: "Plain", draw: Draw.lines("plain") },
          ]} />
          <TriState label="Page icons" value={c("sidebar_icons")} onChange={(v) => set("sidebar_icons", v)} />
        </Group>
        <Group label="Callouts">
          <OptionCards label="Callout style" value={c("callouts")} onChange={(v) => set("callouts", v)} options={[
            { value: "tinted", label: "Tinted", draw: Draw.callout("tinted") },
            { value: "bordered", label: "Bordered", draw: Draw.callout("bordered") },
            { value: "bar", label: "Left bar", draw: Draw.callout("bar") },
          ]} />
        </Group>
        <Group label="Code blocks">
          <OptionCards label="Code theme" value={c("code_theme")} onChange={(v) => set("code_theme", v)} options={[
            { value: "auto", label: "Match page", draw: Draw.code("auto") },
            { value: "light", label: "Light", draw: Draw.code("light") },
            { value: "dark", label: "Dark", draw: Draw.code("dark") },
          ]} />
        </Group>
        <Group label="Links in text">
          <OptionCards label="Link style" value={c("links")} onChange={(v) => set("links", v)} options={[
            { value: "underline", label: "Underlined", draw: Draw.link("underline") },
            { value: "accent", label: "On hover", draw: Draw.link("accent") },
            { value: "plain", label: "Bold", draw: Draw.link("plain") },
          ]} />
        </Group>
      </>
    );
  } else if (section === "icons") {
    body = (
      <>
        <SectionHead title="Icons" hint="One style for every icon in the guide: the sidebar, cards, callouts and the header." onReset={() => resetSection("icons")} canReset={sectionDirty("icons")} />
        <div role="radiogroup" aria-label="Icon style" className="flex flex-col gap-2">
          {([
            ["regular", "Regular", "The standard stroke. Balanced at every size."],
            ["light", "Light", "A finer stroke for airy, editorial themes."],
            ["bold", "Bold", "A heavier stroke that holds up on dense pages."],
            ["duotone", "Duotone", "Shapes washed with their own colour."],
          ] as const).map(([v, label, hint]) => {
            const on = (c("icons") ?? "regular") === v && (v !== "regular" || c("icons") === "regular");
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set("icons", c("icons") === v ? null : v)}
                className={cx("md-focus flex items-center gap-3 rounded-lg bg-surface px-3 py-2.5 text-left", on ? "border-[1.5px] border-accent" : "border border-border hover:bg-surface-hover")}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-semibold text-text">{label}</span>
                  <span className="text-[12px] text-text-muted">{hint}</span>
                </span>
                <IconRow style={v} />
              </button>
            );
          })}
        </div>
        {!c("icons") && <p className="text-[12px] text-text-muted">No style chosen: the theme's own (Regular).</p>}
      </>
    );
  } else {
    body = (
      <>
        <SectionHead title="Custom CSS" hint="For what the controls don't cover. Applied after the theme, scoped to the guide. Scripts aren't allowed." onReset={() => resetSection("advanced")} canReset={sectionDirty("advanced")} />
        <Textarea
          mono
          rows={14}
          aria-label="Custom CSS"
          invalid={!!cssProblem}
          placeholder={".dx-callout { border-radius: 0; }\n.dx-header { backdrop-filter: blur(8px); }"}
          value={theme.custom_css ?? ""}
          onChange={(e) => apply({ ...theme, custom_css: e.target.value }, "css")}
          className="ph-no-capture text-[12.5px]"
        />
        {cssProblem ? (
          <p className="flex items-center gap-1.5 text-[12px] text-danger" role="alert"><Icon name="alertCircle" size={13} /> {cssProblem}</p>
        ) : (
          <p className="text-[12px] text-text-muted">The preview applies it as you type.</p>
        )}
      </>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} className="fixed inset-0 z-[70] flex flex-col bg-bg text-text">
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
        <IconButton icon="arrowLeft" label="Back to Design" onClick={onClose} />
        <div className="flex min-w-0 flex-col">
          <h2 id={`${uid}-title`} ref={title} tabIndex={-1} className="text-[15px] font-semibold leading-5 outline-none">Customize theme</h2>
          <span className="ph-sensitive ph-mask truncate text-[12px] text-text-muted">{siteName}</span>
        </div>
        <span className="mx-1 hidden h-6 w-px bg-border md:block" aria-hidden />
        <label className="hidden items-center gap-2 text-[13px] text-text-secondary md:flex">
          Start from
          <Select
            aria-label="Start from a theme"
            value={theme.preset}
            onChange={(e) => apply({ ...theme, preset: e.target.value as ThemePreset })}
            options={PRESETS.map((p) => ({ value: p.id, label: p.name }))}
            className="h-8 py-0 text-[13px]"
          />
        </label>
        <div className="flex items-center">
          <Tooltip content="Undo (⌘Z)"><IconButton icon="undo" label="Undo" size="sm" disabled={!canUndo} onClick={undo} /></Tooltip>
          <Tooltip content="Redo (⇧⌘Z)"><IconButton icon="redo" label="Redo" size="sm" disabled={!canRedo} onClick={redo} /></Tooltip>
        </div>
        <span className="flex-1" />
        <SegmentedControl
          aria-label="Show"
          size="sm"
          className="lg:hidden"
          value={pane}
          onChange={(v) => setPane(v as typeof pane)}
          options={[{ value: "controls", label: "Controls" }, { value: "preview", label: "Preview" }]}
        />
        {dirty ? <Badge size="sm" tone="warning" dot className="max-sm:hidden">Unsaved</Badge> : null}
        {onSaveTemplate && <Button variant="secondary" size="sm" iconLeft="layers" onClick={() => setNaming(true)} className="max-sm:hidden">Save as template</Button>}
        <Button variant="primary" size="sm" loading={saving} disabled={!!cssProblem || (!dirty && !saving)} onClick={() => void onSave()}>
          {dirty || saving ? "Save design" : "Saved"}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Theme controls" className={cx("flex min-h-0 w-full flex-col border-border bg-surface lg:w-[400px] lg:shrink-0 lg:border-r", pane === "preview" && "max-lg:hidden")}>
          <div className="border-b border-border px-4 py-3">
            <Tabs variant="pill" size="sm" aria-label="Theme sections" className="flex-wrap overflow-visible" value={section} onChange={(v) => setSection(v as Section)} items={SECTIONS.map((s) => ({ value: s.value, label: s.label, icon: s.icon }))} />
          </div>
          <div className="md:hidden border-b border-border px-4 py-2.5">
            <Field label="Start from">
              <Select value={theme.preset} onChange={(e) => apply({ ...theme, preset: e.target.value as ThemePreset })} options={PRESETS.map((p) => ({ value: p.id, label: p.name }))} />
            </Field>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">{body}</div>
          {onSaveTemplate && (
            <div className="border-t border-border px-4 py-2.5 sm:hidden">
              <Button variant="secondary" size="sm" block iconLeft="layers" onClick={() => setNaming(true)}>Save as template</Button>
            </div>
          )}
        </aside>
        <section aria-label="Live preview" className={cx("flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3 sm:p-4", pane === "controls" && "max-lg:hidden")}>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl aria-label="Preview page" size="sm" value={page} onChange={(v) => setPage(v as typeof page)} options={[{ value: "home", label: "Home" }, { value: "article", label: "Article" }]} />
            <SegmentedControl
              aria-label="Preview colour mode"
              size="sm"
              value={mode}
              onChange={(v) => setMode(v as Mode)}
              options={[
                { value: "light", label: "Light", icon: "sun", disabled: theme.mode === "dark" },
                { value: "dark", label: "Dark", icon: "moon", disabled: theme.mode === "light" },
              ]}
            />
            <SegmentedControl
              aria-label="Preview device"
              size="sm"
              iconOnly
              value={device}
              onChange={(v) => setDevice(v as typeof device)}
              options={[{ value: "desktop", label: "Desktop", icon: "monitor" }, { value: "phone", label: "Phone", icon: "phone" }]}
            />
            <span className="flex-1" />
            <span className="text-[12px] text-text-muted max-sm:hidden">{presetName(theme.preset)}{theme.custom ? ", customized" : ""}</span>
            {failing.length > 0 ? (
              <Badge tone="warning" size="sm" icon="alert">{failing.length} contrast {failing.length === 1 ? "issue" : "issues"}</Badge>
            ) : (
              <Badge tone="success" size="sm" icon="check">Readable (AA)</Badge>
            )}
          </div>
          <LivePreview theme={theme} name={siteName} logo={logo} dark={mode === "dark"} page={page} device={device} />
        </section>
      </div>
      <SaveTemplateDialog open={naming} onClose={() => setNaming(false)} onSave={onSaveTemplate} />
    </div>
  );
}

/** The fonts the theme uses with no font picked (resolveTheme's), for "Theme default (…)". */
function resolveFonts(theme: Record<string, unknown>, brand: Parameters<typeof resolveTheme>[1]) {
  return resolveTheme(theme, brand)?.fonts ?? {};
}

function PaletteChip({ label, accent, warm, onPick }: { label: string; accent: string; warm?: boolean; onPick: () => void }) {
  const p = paletteFrom(accent, { warm });
  return (
    <button type="button" onClick={onPick} className="md-focus flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 text-[12px] font-medium text-text hover:bg-surface-hover" title={`${label}: ${accent}`}>
      <span className="flex overflow-hidden rounded-full border border-border" aria-hidden>
        <span className="block size-4" style={{ background: p.light.bg ?? undefined }} />
        <span className="block size-4" style={{ background: accent }} />
        <span className="block size-4" style={{ background: p.dark.bg ?? undefined }} />
      </span>
      {label}
    </button>
  );
}

export function SaveTemplateDialog({ open, onClose, onSave, initial = "", title = "Save as template" }: {
  open: boolean;
  onClose: () => void;
  onSave: ((name: string) => Promise<void>) | null;
  initial?: string;
  title?: string;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setName(initial);
      setError("");
    }
  }, [open, initial]);
  const submit = async () => {
    if (!onSave || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description="Templates keep the design (theme, colours, fonts, shape, layout, icons and custom CSS), not the guide's logo or brand colours. Every guide in this workspace can use them."
      size="sm"
      initialFocus={input}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>Save</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-2">
        <Field label="Name" error={error || undefined}>
          <Input ref={input} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Acme house style" />
        </Field>
      </form>
    </Dialog>
  );
}
