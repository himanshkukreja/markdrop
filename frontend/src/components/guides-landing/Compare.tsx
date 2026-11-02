"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/landing/ds";
import { COMPARED_LABEL, COMPARISON, COMPARE_TOP, type Cell } from "./content";
import s from "./GuidesLanding.module.css";

/**
 * The comparison with GitBook and Mintlify (content.ts, every competitor cell with its source):
 * the five rows that matter most (COMPARE_TOP) by default, "Show all" for the rest. Every row is in
 * the server HTML; the others are `hidden` until asked for.
 */

function CellView({ c, guides }: { c: Cell; guides?: boolean }) {
  const mark = c.tone === "yes" ? "check" : c.tone === "no" ? "x" : "minus";
  const word = c.tone === "yes" ? "Yes" : c.tone === "no" ? "No" : "Partly";
  return (
    <span className={s.cell} data-tone={c.tone}>
      <span className={s.mark} aria-hidden="true">
        <Icon name={mark} size={13} />
      </span>
      <span className="sr-only">{word}: </span>
      <span>
        {c.text}
        {c.href && !guides && (
          <>
            {" "}
            <a href={c.href} target="_blank" rel="noopener noreferrer" className={s.src}>
              source<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        )}
      </span>
    </span>
  );
}

const TOP = new Set<string>(COMPARE_TOP);
const ROWS = [...COMPARE_TOP.map((l) => COMPARISON.find((r) => r.label === l)!), ...COMPARISON.filter((r) => !TOP.has(r.label))];

export default function Compare() {
  const [all, setAll] = useState(false);
  const id = useId();
  return (
    <>
      <div className={s.tableWrap}>
        <table className={s.table} id={id}>
          <caption className="sr-only">Markdrop Guides compared with GitBook and Mintlify, {COMPARED_LABEL}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Feature</span>
              </th>
              <th scope="col" className={s.us}>Markdrop Guides</th>
              <th scope="col">GitBook</th>
              <th scope="col">Mintlify</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label} hidden={!all && !TOP.has(r.label)}>
                <th scope="row">{r.label}</th>
                <td className={s.us} data-col="Markdrop Guides">
                  <CellView c={r.guides} guides />
                </td>
                <td data-col="GitBook">
                  <CellView c={r.gitbook} />
                </td>
                <td data-col="Mintlify">
                  <CellView c={r.mintlify} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className={s.showAll} aria-expanded={all} aria-controls={id} onClick={() => setAll((v) => !v)} data-cta="compare">
        {all ? "Show fewer" : `Show all ${COMPARISON.length} rows`}
        <Icon name={all ? "chevronUp" : "chevronDown"} size={15} />
      </button>
    </>
  );
}
