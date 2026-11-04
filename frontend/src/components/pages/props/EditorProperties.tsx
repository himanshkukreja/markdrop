"use client";

/**
 * The properties panel inside the page editor: values come from the Markdown being edited (its
 * `props:` front-matter line) and a change is written back into it, so it saves, undoes and shows
 * in version history like any other edit (and the server checks it: services/page_db.check_save).
 */
import { useMemo, useRef } from "react";
import { parse as parseYaml } from "yaml";
import type { PagePropertiesInfo } from "./api";
import { readValues, writeValues, type PropValue } from "./model.mjs";
import { PropertiesPanel } from "./PropertiesPanel";

const YAML = { parseYaml: (t: string) => parseYaml(t) as unknown };

export function EditorProperties({ info, markdown, onMarkdown, readOnly, workspaceId, pageHref, extra }: {
  info: PagePropertiesInfo;
  markdown: string;
  onMarkdown: (next: string) => void;
  readOnly?: boolean;
  workspaceId: string | null;
  pageHref?: (slug: string) => string;
  extra?: React.ReactNode;
}) {
  const values = useMemo(() => readValues(markdown, YAML), [markdown]);
  const latest = useRef(markdown);
  latest.current = markdown;
  return (
    <PropertiesPanel
      info={info}
      values={values}
      readOnly={readOnly}
      workspaceId={workspaceId}
      pageHref={pageHref}
      extra={extra}
      onChange={(patch: Record<string, PropValue | null>) => {
        const next = writeValues(latest.current, patch, YAML);
        latest.current = next;
        onMarkdown(next);
      }}
    />
  );
}

export default EditorProperties;
