"use client";

/**
 * The "/" menu's preview card (wide screens, on hover): a small drawing of the block the row
 * inserts. Plain markup and CSS (docs-editor.css, "slash menu"), rendered only for the hovered row.
 */
import type { ReactNode } from "react";
import { Icon } from "@/components/ui";
import type { BlockItem } from "../blocks";

const L = ({ w = 100, dim = false }: { w?: number; dim?: boolean }) => <i className={dim ? "dxe-pv__l dxe-pv__l--dim" : "dxe-pv__l"} style={{ width: `${w}%` }} />;

function sample(id: string): ReactNode {
  const heading = /^h([1-3])$/.exec(id);
  if (heading) return <div className={`dxe-pv__h dxe-pv__h--${heading[1]}`}>Heading {heading[1]}</div>;
  const toggleH = /^toggle-h([1-3])$/.exec(id);
  if (toggleH || id === "toggle" || id === "details")
    return (
      <div className="dxe-pv__toggle">
        <div className={toggleH ? `dxe-pv__h dxe-pv__h--${toggleH[1]}` : "dxe-pv__t"}>
          <Icon name="chevronRight" size={14} className="dxe-pv__chev" /> {toggleH ? `Toggle heading ${toggleH[1]}` : "Toggle"}
        </div>
        <div className="dxe-pv__indent">
          <L w={90} dim />
          <L w={60} dim />
        </div>
      </div>
    );
  if (id.startsWith("callout"))
    return (
      <div className={`dxe-pv__callout dxe-pv__callout--${id.slice(8) || "note"}`}>
        <Icon name={id === "callout-tip" ? "bulb" : id === "callout-warning" ? "alert" : id === "callout-danger" ? "alertCircle" : "info"} size={14} />
        <div>
          <L w={95} />
          <L w={55} />
        </div>
      </div>
    );
  if (id.startsWith("columns")) {
    const n = Number(id.slice(8)) || 2;
    return (
      <div className="dxe-pv__cols">
        {Array.from({ length: n }, (_, i) => (
          <div key={i}>
            <L w={90} />
            <L w={70} dim />
            <L w={80} dim />
          </div>
        ))}
      </div>
    );
  }
  switch (id) {
    case "text":
      return (
        <div className="dxe-pv__t">
          Just start writing with plain text.
          <L w={92} dim />
          <L w={64} dim />
        </div>
      );
    case "tasks":
      return (
        <div className="dxe-pv__list">
          <div><span className="dxe-pv__box dxe-pv__box--on" /> <s>Write the outline</s></div>
          <div><span className="dxe-pv__box" /> Draft the page</div>
          <div><span className="dxe-pv__box" /> Share it</div>
        </div>
      );
    case "bullets":
    case "numbers":
      return (
        <div className="dxe-pv__list">
          {["First thing", "Second thing", "Third thing"].map((t, i) => (
            <div key={t}><span className="dxe-pv__mark">{id === "numbers" ? `${i + 1}.` : "•"}</span> {t}</div>
          ))}
        </div>
      );
    case "quote":
      return <div className="dxe-pv__quote">Ship small, and keep the customer in the room.</div>;
    case "divider":
      return (
        <div className="dxe-pv__stack">
          <L w={80} dim />
          <hr className="dxe-pv__hr" />
          <L w={70} dim />
        </div>
      );
    case "image":
      return (
        <div className="dxe-pv__stack">
          <div className="dxe-pv__img" />
          <span className="dxe-pv__cap">A caption</span>
        </div>
      );
    case "video":
    case "page-video":
    case "clip":
      return (
        <div className="dxe-pv__video">
          <Icon name="play" size={18} />
        </div>
      );
    case "page-audio":
      return (
        <div className="dxe-pv__audio">
          <Icon name="play" size={12} />
          {Array.from({ length: 22 }, (_, i) => (
            <i key={i} style={{ height: `${30 + ((i * 37) % 60)}%` }} />
          ))}
        </div>
      );
    case "page-file":
      return (
        <div className="dxe-pv__card">
          <Icon name="doc" size={16} /> <span>handbook.pdf</span> <span className="dxe-pv__muted">2.4 MB</span>
        </div>
      );
    case "bookmark":
      return (
        <div className="dxe-pv__bookmark">
          <div>
            <b>Example site</b>
            <L w={90} dim />
            <span className="dxe-pv__muted">example.com</span>
          </div>
          <span className="dxe-pv__thumb" />
        </div>
      );
    case "web-embed":
    case "embed":
      return (
        <div className="dxe-pv__frame">
          <span className="dxe-pv__dots"><i /><i /><i /></span>
          <div className="dxe-pv__img dxe-pv__img--short" />
        </div>
      );
    case "page-embed":
    case "markdrop":
      return (
        <div className="dxe-pv__frame">
          <div className="dxe-pv__card dxe-pv__card--flat">
            <Icon name="layers" size={14} /> <b>Q3 report</b> <span className="dxe-pv__muted">PDF</span>
          </div>
          <div className="dxe-pv__img dxe-pv__img--short" />
        </div>
      );
    case "mention":
      return (
        <div className="dxe-pv__t">
          Read <span className="dxe-pv__chip"><Icon name="doc" size={12} /> Launch plan</span> first.
        </div>
      );
    case "subpage":
      return (
        <div className="dxe-pv__t dxe-pv__sub">
          <Icon name="doc" size={15} /> <u>Meeting notes</u>
        </div>
      );
    case "table":
      return (
        <div className="dxe-pv__table">
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} className={i < 3 ? "dxe-pv__th" : undefined} />
          ))}
        </div>
      );
    case "code":
    case "mermaid":
      return id === "code" ? (
        <pre className="dxe-pv__code">{"const page = await create();\npage.publish();"}</pre>
      ) : (
        <div className="dxe-pv__diagram">
          <span>Start</span>
          <i />
          <span>Finish</span>
        </div>
      );
    case "math":
      return <div className="dxe-pv__math">E = mc²</div>;
    case "toc":
      return (
        <div className="dxe-pv__list dxe-pv__toc">
          <div>Introduction</div>
          <div className="dxe-pv__in">Getting started</div>
          <div className="dxe-pv__in">Next steps</div>
        </div>
      );
    case "breadcrumb":
      return <div className="dxe-pv__t dxe-pv__muted">Acme <span>/</span> Guides <span>/</span> <b>This page</b></div>;
    case "button":
      return <span className="dxe-pv__button"><Icon name="plus" size={12} /> Add a task</span>;
    case "person":
      return <div className="dxe-pv__t">Ask <span className="dxe-pv__chip">@Ada Owner</span> to review.</div>;
    case "date":
      return <div className="dxe-pv__t">Due <span className="dxe-pv__chip">@Today</span></div>;
    case "emoji":
      return <div className="dxe-pv__emoji">🚀 ✅ 🎉 💡</div>;
    case "kbd":
      return <div className="dxe-pv__t">Press <kbd className="md-kbd">⌘ K</kbd> to search.</div>;
    case "steps":
      return (
        <div className="dxe-pv__list">
          <div><span className="dxe-pv__num">1</span> Install</div>
          <div><span className="dxe-pv__num">2</span> Sign in</div>
        </div>
      );
    case "tabs":
      return (
        <div className="dxe-pv__tabs">
          <span className="dxe-pv__tab--on">macOS</span>
          <span>Windows</span>
          <span>Linux</span>
        </div>
      );
    case "cards":
      return (
        <div className="dxe-pv__cols">
          {[0, 1].map((i) => (
            <div key={i} className="dxe-pv__card dxe-pv__card--col">
              <Icon name="doc" size={14} />
              <L w={80} />
            </div>
          ))}
        </div>
      );
    case "private":
      return (
        <div className="dxe-pv__callout dxe-pv__callout--note">
          <Icon name="lock" size={14} />
          <div>
            <L w={90} />
            <L w={50} />
          </div>
        </div>
      );
    case "api":
      return (
        <div className="dxe-pv__card">
          <b className="dxe-pv__method">GET</b> <code>/v1/pages</code>
        </div>
      );
    default:
      return null;
  }
}

export function SlashPreview({ item }: { item: BlockItem }) {
  const drawing = sample(item.id);
  return (
    <div className="dxe-slash__preview" aria-hidden>
      <div className="dxe-pv">{drawing ?? <Icon name={item.icon} size={28} />}</div>
      <div className="dxe-slash__previewtext">
        <b>{item.label}</b>
        <span>{item.hint}</span>
      </div>
    </div>
  );
}
