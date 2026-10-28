/**
 * Server-safe half of the theme plumbing: the constants and the inline <head> script. The hooks
 * live in lib/theme.ts ("use client"), which re-exports these. See that file for the model.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "md_theme";
/**
 * Light launch flag (REVAMP_BUILD §4.5, D1/O3). Light is offered to everyone only when the build sets
 * NEXT_PUBLIC_LIGHT_THEME=true; otherwise every visitor gets dark, except browsers that opted into the
 * beta (localStorage md_theme_beta = "1", set from /settings/account). Inlined at build time.
 */
export const LIGHT_ENABLED = process.env.NEXT_PUBLIC_LIGHT_THEME === "true";
export const BETA_KEY = "md_theme_beta";
export const THEME_COLOR: Record<ResolvedTheme, string> = { dark: "#030712", light: "#E3E7ED" };

/**
 * The inline <head> script. Static (no request data), so it is safe in ISR HTML. It runs during
 * parsing, before any paint, so there is no flash. It also drops the legacy `theme` key: every past
 * visitor has `theme=dark` written by the old script, and honouring it would pin them to dark.
 * Someone who never chose gets light; "system" is followed only when it was picked.
 */
export function themeScript(lightEnabled: boolean = LIGHT_ENABLED): string {
  return `(function(){var d=document.documentElement,t='dark';try{var ls=localStorage;ls.removeItem('theme');if(${
    lightEnabled ? "true" : "ls.getItem('md_theme_beta')==='1'"
  }){var s=ls.getItem('md_theme');t=(s==='light'||s==='dark')?s:s==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):'light';}}catch(e){}d.setAttribute('data-theme',t);d.classList.toggle('dark',t==='dark');d.classList.add('js');var h=document.head;h.querySelectorAll('meta[name=theme-color]').forEach(function(m){m.remove()});var m=document.createElement('meta');m.name='theme-color';m.content=t==='light'?'${THEME_COLOR.light}':'${THEME_COLOR.dark}';h.appendChild(m);})();`;
}
