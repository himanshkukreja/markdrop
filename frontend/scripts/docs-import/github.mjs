#!/usr/bin/env node
/**
 * A repository's docs → a Markdrop Docs content folder (Import from GitHub).
 *
 *   node scripts/docs-import/github.mjs --dir <repo checkout> --path <folder> --out <dir> --id import
 *        [--format auto|markdown|gitbook|mintlify|docusaurus|mkdocs] [--repo owner/name] [--ref <sha>]
 *        [--branch <b>] [--date YYYY-MM-DD] [--allow-repo]
 *
 *   --dir      the repository, already on disk (the runner unpacks GitHub's tarball into it)
 *   --path     the folder to import, repo-relative ("" = the root): the project folder for config
 *              formats (where docs.json, mkdocs.yml, docusaurus.config.* or .gitbook.yaml is), the
 *              content folder for plain Markdown
 *   --format   auto (default) detects it (lib/repo/detect.mjs)
 *   --repo/--ref/--branch  for links to repo files that aren't pages (github.com/<repo>/blob/<branch|ref>/…)
 *   --allow-repo  allow --out inside this git repository (imported content is someone else's)
 *
 * Reads files only: never runs anything from the repo (Docusaurus sidebars and configs are read as
 * text) and never fetches anything (remote images stay remote). Output: site.json, one .md per page
 * (front matter title, nav, description, updated, icon), public/docs-assets/<id>/…, redirects.json,
 * videos.json, _origins.json (page → repo file), _import-report.json and _IMPORT_REPORT.md.
 * Progress on stdout: "pages: N", "progress: pages i/N", "progress: assets i/N", "done: …".
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ImportError, convertRepo, writeOutput } from "./lib/repo/repo.mjs";
import { FORMATS } from "./lib/repo/detect.mjs";

export { convertRepo, writeOutput, readRepoDir, mapIcon, splitFrontMatter, leadingH1, parseRepoName, FORMAT_MODULES, ImportError } from "./lib/repo/repo.mjs";
export { detectFormat, suggestFolders, inspectFolders, listPages, FORMATS } from "./lib/repo/detect.mjs";
export { parseJsLiteral, parseSidebarsFile } from "./lib/repo/jsliteral.mjs";
export { convertMdx } from "./lib/repo/mdx.mjs";
export { convertAdmonitions } from "./lib/repo/admonitions.mjs";
export { parseSummary } from "./lib/repo/nav/gitbook.mjs";
export { docsJsonSections, mintJsonSections } from "./lib/repo/nav/mintlify.mjs";
export { docId, docUrlSegments } from "./lib/repo/nav/docusaurus.mjs";
export { folderNav } from "./lib/repo/nav/folders.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === "allow-repo") out[k] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[k] = v;
    }
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const usage = "usage: node scripts/docs-import/github.mjs --dir <repo dir> --path <folder> --out <dir> --id import [--format auto|markdown|gitbook|mintlify|docusaurus|mkdocs] [--repo owner/name] [--ref sha] [--branch b] [--date YYYY-MM-DD]";
  if (!args.dir || !args.out) {
    console.error(usage);
    process.exit(2);
  }
  const format = args.format || "auto";
  if (format !== "auto" && !FORMATS.includes(format)) {
    console.error(`unknown --format ${format} (auto, ${FORMATS.join(", ")})`);
    process.exit(2);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error("--date is YYYY-MM-DD");
    process.exit(2);
  }
  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`no such folder: ${dir}`);
    process.exit(2);
  }
  const OUT = path.resolve(args.out);
  if (!args["allow-repo"] && (OUT + path.sep).startsWith(REPO + path.sep)) {
    console.error(`refusing to write into the repository (${OUT}): imported docs are third-party content. Use a folder outside it, or --allow-repo.`);
    process.exit(2);
  }
  const id = args.id || "import";
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) {
    console.error("--id is lowercase letters, digits and hyphens");
    process.exit(2);
  }
  const folder = String(args.path ?? "").replace(/^\/+|\/+$/g, "");
  console.log(`GitHub import: ${args.repo ?? path.basename(dir)}${folder ? `/${folder}` : ""} → ${OUT} (format ${format})`);
  try {
    const res = await convertRepo({ dir, path: folder, format, repo: args.repo, ref: args.ref, branch: args.branch, date: args.date, id, log: (l) => console.log(l) });
    writeOutput(res, OUT);
    const c = res.report.counts;
    console.log(`format: ${res.format} (content root ${res.det.contentRoot || "/"})`);
    console.log(`done: ${c.pages} pages, ${c.groups} groups, ${c.images + c.files} assets, ${c.notes} notes, ${c.brokenLinks} broken links, ${c.missing} missing, ${c.keptOriginal} kept original → ${path.join(OUT, "_IMPORT_REPORT.md")}`);
  } catch (e) {
    if (e instanceof ImportError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
