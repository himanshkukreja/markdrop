import type { MetadataRoute } from "next";

/** Web app manifest (REVAMP_BUILD R40): name, the system mark, and theme colours for both themes. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Markdrop",
    short_name: "Markdrop",
    description: "Docs and files as links that render",
    start_url: "/",
    display: "browser",
    background_color: "#030712",
    theme_color: "#030712",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/apple-icon", type: "image/png", sizes: "180x180" },
    ],
  };
}
