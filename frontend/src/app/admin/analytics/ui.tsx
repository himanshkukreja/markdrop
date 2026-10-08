"use client";

/** Shared building blocks for the analytics tab. */

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-2xl border border-gray-800/80 bg-gray-900/40 p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function CardTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="inline-flex min-w-0 max-w-full p-0.5 rounded-lg bg-gray-950 border border-gray-800 overflow-x-auto [scrollbar-width:none]">
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${value === k ? "bg-gray-800 text-gray-50" : "text-gray-400 hover:text-gray-200"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Delta({ now, prev, lowerIsBetter }: { now: number; prev: number; lowerIsBetter?: boolean }) {
  if (!prev && !now) return null;
  if (!prev) return <span className="text-[11px] font-medium text-gray-400">New</span>;
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return <span className="text-[11px] font-medium text-gray-500">0%</span>;
  const up = pct > 0;
  const good = lowerIsBetter ? !up : up;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${good ? "text-[#0ca30c]" : "text-[#e66767]"}`}
      title={`${up ? "Up" : "Down"} ${Math.abs(pct)}% vs the previous period`}>
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={up ? "M7 14l5-5 5 5" : "M7 10l5 5 5-5"} />
      </svg>
      {Math.abs(pct)}%
    </span>
  );
}

export function Stat({ label, value, now, prev, foot, active, onClick, lowerIsBetter, live }: {
  label: string; value: string; now?: number; prev?: number; foot?: string; active?: boolean;
  onClick?: () => void; lowerIsBetter?: boolean; live?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick}
      className={`text-left rounded-2xl border p-4 transition-colors ${active
        ? "border-blue-500/60 bg-blue-500/[0.07] ring-1 ring-blue-500/30"
        : "border-gray-800/80 bg-gray-900/40"} ${onClick ? "hover:border-gray-700 cursor-pointer" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-400 flex items-center gap-1.5">
          {live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
          {label}
        </p>
        {now !== undefined && prev !== undefined && <Delta now={now} prev={prev} lowerIsBetter={lowerIsBetter} />}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-gray-50">{value}</p>
      {foot && <p className="mt-1 text-[11px] text-gray-500 truncate">{foot}</p>}
    </Tag>
  );
}

