/**
 * The landing page's looping clips (public/guides-landing/), recorded from the real product on the
 * docs-media sandbox stack with fictional data (frontend/scripts/docs-media/shots/e-guides-landing.mjs,
 * cut and encoded by scripts/docs-media/landing-loops.mjs). w × h is the files' size; `label` is the
 * text alternative (the poster's alt), `caption` a longer description for the figure.
 */
export interface Loop {
  src: string;
  w: number;
  h: number;
  label: string;
  caption?: string;
}

export const LOOPS = {
  heroFix: {
    src: "/guides-landing/hero-fix",
    w: 1600,
    h: 1000,
    label: "The Fix list in the Markdrop Guides studio: readers leave at Install the CLI is ranked first; its evidence, a drafted fix accepted in the editor, a publish, and the item marked fixed.",
    caption:
      "A recording of the studio with fictional data: the Fix list ranks “Readers leave at Install the CLI” first (42% of readers stop there). Opening it shows the evidence section by section; Draft a fix writes an edit, which opens in the editor as a suggestion; Accept, then Publish, and the item is marked fixed by that publish.",
  },
  calc: {
    src: "/guides-landing/demo-calc",
    w: 800,
    h: 640,
    label: "A pricing calculator embedded in a docs page: choosing the Scale plan, dragging the seats slider and switching to monthly billing updates the total.",
  },
  private: {
    src: "/guides-landing/private-unlock",
    w: 800,
    h: 600,
    label: "A public Single sign-on page with a locked Northwind section: a reader signs in with jane@northwind.com through an emailed link, and the section opens, marked Only Northwind.",
  },
  editorFix: {
    src: "/guides-landing/fix-editor",
    w: 1200,
    h: 760,
    label: "A drafted fix offered over the Install the CLI section in the editor, accepted with one click.",
  },
  import: {
    src: "/guides-landing/import",
    w: 960,
    h: 436,
    label: "Importing a GitBook site: the studio reads the navigation, copies pages and images and saves them as drafts, then lists what needs a look before publishing.",
  },
} satisfies Record<string, Loop>;
