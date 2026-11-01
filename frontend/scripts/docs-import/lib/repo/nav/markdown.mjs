/**
 * Plain Markdown folders: the README/index at the content root is the home, the root's other pages
 * "Getting started", each top-level folder a group (lib/repo/nav/folders.mjs).
 */
import { folderNav } from "./folders.mjs";

export default {
  name: "markdown",
  flavor: "markdown",
  nav(env) {
    const { groups, home } = folderNav(env.pages, { root: env.det.contentRoot });
    return { groups, tabs: [], navTitles: new Map(), home, redirects: [] };
  },
  brand() {
    return {};
  },
};
