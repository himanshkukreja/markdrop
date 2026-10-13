/**
 * Server-safe half of the theme plumbing: the constants and the inline <head> script. The hooks
 * live in lib/theme.ts ("use client"), which re-exports these. See that file for the model.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "md_theme";
/** Kill switch: NEXT_PUBLIC_LIGHT_THEME=off pins every visitor to dark. */
export const LIGHT_ENABLED = process.env.NEXT_PUBLIC_LIGHT_THEME !== "off";
export const THEME_COLOR: Record<ResolvedTheme, string> = { dark: "#030712", light: "#E3E7ED" };

/**
 * The inline <head> script. Static (no request data), so it is safe in ISR HTML. It runs during
 * parsing, before any paint, so there is no flash. It also drops the legacy `theme` key: every past
 * visitor has `theme=dark` written by the old script, and honouring it would pin them to dark.
 */
export function themeScript(lightEnabled: boolean = LIGHT_ENABLED): string {
  return `(function(){var d=document.documentElement,t='dark';try{var ls=localStorage;ls.removeItem('theme');${
    lightEnabled
      ? "var s=ls.getItem('md_theme');t=(s==='light'||s==='dark')?s:(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');"
      : ""
  }}catch(e){}d.setAttribute('data-theme',t);d.classList.toggle('dark',t==='dark');d.classList.add('js');var h=document.head;h.querySelectorAll('meta[name=theme-color]').forEach(function(m){m.remove()});var m=document.createElement('meta');m.name='theme-color';m.content=t==='light'?'${THEME_COLOR.light}':'${THEME_COLOR.dark}';h.appendChild(m);})();`;
}
