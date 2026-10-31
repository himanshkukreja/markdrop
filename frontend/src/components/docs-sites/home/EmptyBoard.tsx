"use client";

import { Anchor, Badge, Button, Icon } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { useTheme } from "@/lib/theme";
import { studioNew, type NewGuideStart, type StudioScope } from "../routes";
import { previewTokens } from "../presets";

export const STARTS: Array<{ start: NewGuideStart; icon: string; title: string; short: string; note: string }> = [
  { start: "blank", icon: "doc", title: "Blank guide", short: "Blank", note: "A home page and the editor. Add pages as you go." },
  { start: "template", icon: "builder", title: "From a template", short: "Template", note: "Help center, product guide or API reference, ready to fill in." },
  { start: "gitbook", icon: "download", title: "Import from GitBook", short: "GitBook", note: "Paste your docs address. Pages, images and old links come across." },
  { start: "openapi", icon: "code", title: "API reference", short: "OpenAPI", note: "The API reference template: add your OpenAPI file, and readers get every endpoint and Try it." },
];

const GETS: Array<{ icon: string; title: string; note: string }> = [
  { icon: "search", title: "Search and Ask AI", note: "Answers from your pages, with a link to the exact section." },
  { icon: "globe", title: "Its own address", note: "name.guides.markdrop.in, or your domain with one DNS record." },
  { icon: "sun", title: "Themes and your brand", note: "Six looks, or Match my brand from your logo and colour." },
  { icon: "eye", title: "Insights", note: "Top pages, searches with no results, page feedback. No cookies." },
  { icon: "check", title: "Drafts and review", note: "Nothing goes live until you publish, or a reviewer approves." },
  { icon: "zap", title: "Ready for AI tools", note: "Markdown copies, llms.txt and an MCP server for every guide." },
];

/** The hero's drawing: a made-up help center ("Northwind Help") in the Clean theme with an orange brand. */
function SampleGuide() {
  const { resolved } = useTheme();
  const t = previewTokens({ preset: "clean", brand: { enabled: true, accent: "#c2410c", colors: [] }, fonts: {}, corners: null }, resolved === "dark");
  const line = (w: string, h = 7) => <span className="block rounded" style={{ width: w, height: h, background: t.line }} />;
  return (
    <div aria-hidden className="min-w-0 flex-[1_1_440px] rounded-2xl border border-border bg-surface-inset px-[18px] pt-[18px]">
      <div className="flex h-[300px] flex-col overflow-hidden rounded-t-xl border border-b-0 shadow-lg" style={{ background: t.bg, borderColor: t.line }}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3.5" style={{ background: t.header, borderColor: t.line }}>
          <span className="grid size-5 place-items-center rounded-md text-[11px] font-extrabold" style={{ background: t.accent, color: t.onAccent }}>N</span>
          <span className="text-[13px] font-bold" style={{ color: t.text }}>Northwind Help</span>
          <span className="flex-1" />
          <span className="inline-flex h-6 items-center rounded-full px-2.5 text-[11px]" style={{ background: t.line, color: t.muted }}>Ask AI</span>
        </div>
        <div className="flex min-h-0 flex-1 gap-4 p-4">
          <div className="flex w-[110px] shrink-0 flex-col gap-2 text-[11px] max-[480px]:hidden" style={{ color: t.muted }}>
            <span className="font-bold" style={{ color: t.accentText }}>Getting started</span>
            <span>Your account</span><span>Orders</span><span>Shipping</span><span>Returns</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-[9px]">
            <span className="text-[18px] font-extrabold" style={{ color: t.text }}>Track an order</span>
            {line("94%")}{line("86%")}{line("72%")}
            <span className="mt-1 flex flex-col gap-1.5 rounded-lg px-3 py-2.5" style={{ background: t.soft, borderLeft: `3px solid ${t.accent}` }}>
              <span className="text-[11px] font-bold" style={{ color: t.text }}>Tip</span>
              {line("80%", 6)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The first visit (Empty board): no guides at all yet. What a guide is, New guide / Import from
 * GitBook, the four ways to start (each opens the new-guide form with it chosen), what every guide
 * comes with, and how workspaces and Guides roles fit in.
 */
export function EmptyBoard({ scope, noRole }: { scope: StudioScope | null; noRole: string[] }) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1168px] flex-col gap-10 px-4 pb-16 pt-8 outline-none sm:px-6 sm:pt-14">
      <section aria-labelledby="first-title" className="flex flex-wrap items-center gap-10">
        <div className="flex min-w-0 flex-[1_1_440px] flex-col gap-3.5">
          <Badge tone="info" size="sm" upper className="self-start">Free while in beta</Badge>
          <h1 id="first-title" className="text-[30px] font-extrabold leading-9 tracking-[-0.03em] text-text sm:text-[36px] sm:leading-[44px]">Publish your first guide</h1>
          <p className="max-w-[520px] text-[16px] leading-[26px] text-text-secondary">
            A help center, product guide or handbook your readers can search and ask questions of. Write it in the editor, pick a look, and it goes live at its own address in about a minute.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button variant="primary" size="lg" iconLeft="plus" href={studioNew(scope)} className="max-sm:w-full">New guide</Button>
            <Button variant="secondary" size="lg" iconLeft="download" href={studioNew(scope, "gitbook")} className="max-sm:w-full">Import from GitBook</Button>
          </div>
        </div>
        <SampleGuide />
      </section>

      <section aria-labelledby="first-start" className="flex flex-col gap-3.5">
        <h2 id="first-start" className="text-[18px] font-semibold leading-7 text-text">How do you want to start?</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STARTS.map((s) => (
            <Anchor
              key={s.start}
              href={studioNew(scope, s.start)}
              className="md-focus flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-[18px] text-text no-underline shadow-sm transition-colors hover:border-border-strong hover:bg-surface-hover"
            >
              <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden><Icon name={s.icon} size={18} /></span>
              <strong className="text-[15px] font-semibold leading-[22px]">{s.title}</strong>
              <span className="text-body text-text-secondary">{s.note}</span>
            </Anchor>
          ))}
        </div>
      </section>

      <section aria-labelledby="first-get" className="flex flex-col gap-3.5 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <h2 id="first-get" className="text-[18px] font-semibold leading-7 text-text">Every guide comes with</h2>
        <div className="grid grid-cols-1 gap-x-6 gap-y-[18px] sm:grid-cols-2 lg:grid-cols-3">
          {GETS.map((g) => (
            <div key={g.title} className="flex gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-inset text-text-secondary" aria-hidden><Icon name={g.icon} size={16} /></span>
              <span className="flex flex-col gap-0.5">
                <strong className="font-semibold text-text">{g.title}</strong>
                <span className="text-[13px] leading-5 text-text-muted">{g.note}</span>
              </span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[13px] leading-5 text-text-muted">
          Guides use your Markdrop workspaces: invite your team once, then give each person a Guides role.{" "}
          {noRole.length > 0 && (
            <>You don&apos;t have a Guides role in <span className="ph-sensitive ph-mask">{noRole.join(", ")}</span> yet: a Guides admin there can give you one, and its guides show here. </>
          )}
          <ReadMore topic="guidesOverview">Read the guide to Guides</ReadMore>
        </p>
      </section>
    </main>
  );
}

export default EmptyBoard;
