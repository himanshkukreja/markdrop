/**
 * The engine stage: a copy of the frontend app in which only the docs routes are routable.
 *
 * The docs engine is the frontend's own code (src/docs + src/app/docs-site + the root layout and
 * middleware), so a site is built by the SAME Next app that serves docs.markdrop.in. Building the
 * whole app per site would compile ~60 app routes nobody reads, so the stage keeps src/ intact but
 * renames every app route folder the docs don't need to `_off-<name>`: Next treats `_`-prefixed
 * folders as private (never routes, never compiled unless imported) while Tailwind still scans
 * them, so the CSS matches the full build's.
 *
 * The stage lives in a work folder that is reused between builds, so Next's webpack cache
 * (.next/cache) makes the second build of any site fast. Files are only rewritten when their
 * content changed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** src/app entries a docs build keeps: the root layout and its files, and the docs tree. */
const KEEP_APP = new Set([
  "layout.tsx",
  "globals.css",
  "fonts",
  "icon.svg",
  "apple-icon.tsx",
  "not-found.tsx",
  "error.tsx",
  "global-error.tsx",
  "docs-site",
]);

/** Project files copied next to src/. next.config.ts is wrapped (see CONFIG below). */
const PROJECT_FILES = ["package.json", "tsconfig.json", "postcss.config.mjs", "next-env.d.ts"];

/**
 * The stage's next.config: the frontend's own config plus what a per-site build needs.
 * - buildId: the engine version (MARKDROP_DOCS_BUILD_ID), not a random id. Every page embeds the
 *   build id, so a random one would change every object on every publish; an engine-version id
 *   means a content edit only changes the pages it touches.
 * - no type-check / lint: that is the engine's CI's job, not every site build's.
 */
const CONFIG = `import base from "./next.config.base";
import type { NextConfig } from "next";

const config: NextConfig = {
  ...base,
  generateBuildId: async () => process.env.MARKDROP_DOCS_BUILD_ID || null,
  typescript: { ...(base.typescript || {}), ignoreBuildErrors: true },
  eslint: { ...(base.eslint || {}), ignoreDuringBuilds: true },
};

export default config;
`;

function writeIfChanged(file, data) {
  try {
    const cur = fs.readFileSync(file);
    if (Buffer.isBuffer(data) ? cur.equals(data) : cur.toString("utf8") === data) return false;
  } catch {
    /* missing */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return true;
}

/** Mirror src → dst (files only rewritten when changed; files gone from src removed from dst). */
function mirror(src, dst, rename = (name) => name, own = new Set()) {
  const seen = new Set(own);
  let changed = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const out = rename(e.name);
    if (out === null) continue;
    seen.add(out);
    const s = path.join(src, e.name);
    const d = path.join(dst, out);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      changed += mirror(s, d);
    } else if (e.isFile()) {
      if (writeIfChanged(d, fs.readFileSync(s))) changed++;
    }
  }
  for (const e of fs.existsSync(dst) ? fs.readdirSync(dst) : []) {
    if (!seen.has(e)) {
      fs.rmSync(path.join(dst, e), { recursive: true, force: true });
      changed++;
    }
  }
  return changed;
}

/**
 * Link a site's asset folders into the stage's public/: `{dir, prefix: "/"}` links each entry of
 * dir at the root, `{dir, prefix: "/docs-assets"}` links dir itself at that path.
 */
function linkPublic(pub, assets) {
  fs.rmSync(pub, { recursive: true, force: true });
  fs.mkdirSync(pub, { recursive: true });
  for (const { dir, prefix } of assets) {
    if (!fs.existsSync(dir)) continue;
    const real = fs.realpathSync(dir);
    if (prefix === "/" || prefix === "") {
      for (const e of fs.readdirSync(real)) {
        if (!e.startsWith(".")) fs.symlinkSync(path.join(real, e), path.join(pub, e));
      }
    } else {
      const at = path.join(pub, prefix.replace(/^\/+/, ""));
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(real, at);
    }
  }
}

/**
 * A short hash of the engine's source: the build id, so the same engine gives the same ids. It
 * covers all of src/ except the app routes the stage turns off (shared components count: the docs
 * import them). Tailwind still scans those routes, so a class added only there can change the CSS
 * file; that shows up as a changed chunk object, not as a stale page.
 */
export function engineVersion(engineDir) {
  const h = crypto.createHash("sha256");
  const appDir = path.join(engineDir, "src", "app");
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".DS_Store") continue;
      // App routes the stage turns off don't shape a docs build: editing the dashboard must not
      // change every docs page's build id (and so re-upload every page).
      if (dir === appDir && !KEEP_APP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        h.update(path.relative(engineDir, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(path.join(engineDir, "src"));
  for (const f of [...PROJECT_FILES, "next.config.ts", "package-lock.json"]) {
    try {
      h.update(f);
      h.update(fs.readFileSync(path.join(engineDir, f)));
    } catch {
      /* optional */
    }
  }
  // So do the stage's own rules (which routes are kept, the config wrapper).
  h.update(fs.readFileSync(new URL(import.meta.url)));
  // The installed Next version shapes the output too.
  try {
    h.update(JSON.parse(fs.readFileSync(path.join(engineDir, "node_modules/next/package.json"), "utf8")).version);
  } catch {
    /* not installed */
  }
  return "e" + h.digest("hex").slice(0, 16);
}

/**
 * Create or refresh the stage in `stageDir` from the frontend at `engineDir`. Returns the number
 * of files that changed (0 on a rebuild with the same engine).
 */
export function stage({ engineDir, stageDir, assets = [], exportMode = false }) {
  fs.mkdirSync(stageDir, { recursive: true });
  let changed = 0;
  // src/: everything, with app routes outside the docs renamed private.
  const srcIn = path.join(engineDir, "src");
  const srcOut = path.join(stageDir, "src");
  fs.mkdirSync(srcOut, { recursive: true });
  changed += mirror(srcIn, srcOut, (name) => (name === "app" ? null : name), new Set(["app"]));
  const appOut = path.join(srcOut, "app");
  fs.mkdirSync(appOut, { recursive: true });
  changed += mirror(path.join(srcIn, "app"), appOut, (name) => {
    if (KEEP_APP.has(name)) return name;
    return name.startsWith("_") ? name : `_off-${name.replace(/[()[\]]/g, "")}`;
  });
  if (exportMode) {
    // Experiment (option B): `output: "export"` can't have middleware or a dynamic route.
    fs.rmSync(path.join(srcOut, "middleware.ts"), { force: true });
    fs.rmSync(path.join(appOut, "docs-site", "mcp"), { recursive: true, force: true });
  }
  for (const f of PROJECT_FILES) {
    const s = path.join(engineDir, f);
    if (fs.existsSync(s)) changed += writeIfChanged(path.join(stageDir, f), fs.readFileSync(s)) ? 1 : 0;
  }
  changed += writeIfChanged(path.join(stageDir, "next.config.base.ts"), fs.readFileSync(path.join(engineDir, "next.config.ts"))) ? 1 : 0;
  const config = exportMode ? CONFIG.replace("...base,", '...base,\n  output: "export",') : CONFIG;
  changed += writeIfChanged(path.join(stageDir, "next.config.ts"), config) ? 1 : 0;
  // public/: only the site's own files (linked, not copied), never Markdrop's app files. The engine
  // reads some of them while rendering (video chapters, media.ts), so they must be there.
  linkPublic(path.join(stageDir, "public"), assets);
  const nm = path.join(stageDir, "node_modules");
  if (!fs.existsSync(nm)) fs.symlinkSync(fs.realpathSync(path.join(engineDir, "node_modules")), nm);
  return changed;
}
