// Ambient declaration for global CSS side-effect imports (e.g. KaTeX / highlight.js
// stylesheets). Next.js resolves these at build time via its webpack loaders;
// this only keeps TypeScript / the editor happy.
declare module "*.css";
