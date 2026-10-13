// Builds the browser bundle used by the previews (and by any non-React-build page):
//   bundle/markdrop.js   one IIFE that reads window.React / window.ReactDOM and sets window.Markdrop
//   bundle/markdrop.css  the component stylesheet
// Source: frontend/src/components/ui/ — the canonical copy since the components were vendored into
// the app (README "Use it in the Next.js app", step 4). Edit the components there, then run this.
// Run: npm run build:bundle
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ui = path.resolve(root, "../frontend/src/components/ui");
const globals = {
  name: "react-globals",
  setup(b) {
    b.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({ path: path.join(root, "scripts/jsx-shim.js") }));
    b.onResolve({ filter: /^react(-dom)?$/ }, (a) => ({ path: a.path, namespace: "g" }));
    b.onLoad({ filter: /.*/, namespace: "g" }, (a) => ({ contents: `module.exports = window.${a.path === "react" ? "React" : "ReactDOM"};`, loader: "js" }));
  },
};

const r = await esbuild.build({
  entryPoints: [path.join(ui, "index.ts")],
  bundle: true, format: "iife", globalName: "Markdrop", minify: true, write: false,
  jsx: "automatic", target: "es2019", define: { "process.env.NODE_ENV": '"production"' },
  // The modules carry "use client" for Next.js; it means nothing in an IIFE.
  logOverride: { "module-level-directive": "silent" },
  plugins: [globals], logLevel: "warning",
});
const js = r.outputFiles[0].text.replace(/^var Markdrop=/, "window.Markdrop=");
fs.mkdirSync(path.join(root, "bundle"), { recursive: true });
fs.writeFileSync(path.join(root, "bundle/markdrop.js"), js);
fs.copyFileSync(path.join(ui, "markdrop.css"), path.join(root, "bundle/markdrop.css"));
console.log(`bundle/markdrop.js ${(js.length / 1024).toFixed(1)} KB · bundle/markdrop.css (from frontend/src/components/ui)`);
