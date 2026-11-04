// The themed covers (auto covers, 2026-11): one or two per kind of page (product, engineering,
// release, meeting, research, design, ops, people, finance, marketing, legal, support, data,
// security, roadmap, retro, onboarding, docs, strategy), drawn with the same helpers and palette as
// the first twelve: Mist light (#E3E7ED / #EBEEF2), ink (#0E1524), one accent (#2150D8), and the
// quiet sand, peach and sage of linen, dawn and sage. No text anywhere.
//
// Each cover: [name, category, tint ("light" | "dark"), tags]. The tags are what a page is about
// (auto covers match on them: backend/app/services/page_covers.py).

export const THEMED_META = {
  facets: ["Facets", "Shapes", "light", ["product", "feature", "spec", "prd", "requirements", "launch plan", "platform"]],
  prism: ["Prism", "Duotone", "dark", ["product", "vision", "strategy", "insight", "feature", "prd"]],
  circuit: ["Circuit", "Lines", "light", ["engineering", "architecture", "api", "backend", "system", "technical", "code", "infrastructure"]],
  ascent: ["Ascent", "Shapes", "light", ["release", "launch", "release notes", "changelog", "ship", "milestone", "go-live"]],
  circles: ["Circles", "Shapes", "light", ["meeting", "meeting notes", "sync", "standup", "agenda", "1:1", "workshop", "collaboration"]],
  orbit: ["Orbit", "Shapes", "dark", ["meeting", "all-hands", "weekly", "sync", "agenda", "review", "planning"]],
  constellation: ["Constellation", "Calm", "dark", ["research", "discovery", "user research", "interviews", "insights", "analysis", "exploration"]],
  swatches: ["Swatches", "Shapes", "light", ["design", "brand", "ui", "ux", "style guide", "design system", "colors", "mockups"]],
  bezier: ["Bézier", "Shapes", "dark", ["design", "illustration", "ux", "prototype", "figma", "creative", "brand"]],
  pulse: ["Pulse", "Lines", "light", ["ops", "operations", "monitoring", "on-call", "runbook", "uptime", "health", "sre"]],
  terminal: ["Terminal", "Paper", "dark", ["runbook", "incident", "ops", "devops", "logs", "deploy", "postmortem", "cli"]],
  gather: ["Gather", "Shapes", "light", ["people", "hr", "team", "hiring", "culture", "handbook", "benefits", "recruiting"]],
  lanterns: ["Lanterns", "Calm", "dark", ["people", "team", "community", "culture", "celebration", "offsite", "events"]],
  ledger: ["Ledger", "Paper", "light", ["finance", "budget", "accounting", "invoice", "expenses", "pricing", "costs", "forecast"]],
  columns: ["Columns", "Duotone", "dark", ["finance", "revenue", "growth", "metrics", "kpi", "sales", "quarterly", "board"]],
  signal: ["Signal", "Duotone", "dark", ["marketing", "announcement", "campaign", "press", "newsletter", "social", "launch"]],
  confetti: ["Confetti", "Shapes", "light", ["marketing", "celebration", "announcement", "event", "party", "newsletter", "wins"]],
  seal: ["Seal", "Paper", "light", ["legal", "contract", "policy", "terms", "agreement", "compliance", "privacy policy"]],
  pillars: ["Pillars", "Duotone", "dark", ["legal", "governance", "compliance", "policy", "principles", "values", "charter"]],
  bubbles: ["Bubbles", "Shapes", "light", ["support", "help", "faq", "customer", "how-to", "chat", "feedback", "troubleshooting"]],
  beacon: ["Beacon", "Calm", "dark", ["support", "help center", "guide", "escalation", "customer success", "service"]],
  scatter: ["Scatter", "Lines", "light", ["data", "analytics", "metrics", "experiment", "a/b test", "statistics", "dashboard", "report"]],
  heatmap: ["Heatmap", "Duotone", "dark", ["data", "analytics", "usage", "activity", "dashboard", "sql", "warehouse"]],
  lattice: ["Lattice", "Lines", "light", ["security", "access", "permissions", "audit", "encryption", "compliance", "soc 2"]],
  vault: ["Vault", "Duotone", "dark", ["security", "secrets", "incident", "threat model", "keys", "vulnerability", "pentest"]],
  route: ["Route", "Lines", "light", ["roadmap", "plan", "timeline", "milestones", "okrs", "goals", "quarter", "journey"]],
  waypoints: ["Waypoints", "Lines", "dark", ["roadmap", "timeline", "milestones", "project", "schedule", "phases", "gantt"]],
  tide: ["Tide", "Calm", "light", ["retro", "retrospective", "reflection", "lessons learned", "review", "journal", "wellbeing"]],
  doorway: ["Doorway", "Calm", "light", ["onboarding", "welcome", "getting started", "new hire", "orientation", "introduction", "first day"]],
  sheets: ["Sheets", "Paper", "light", ["docs", "documentation", "notes", "wiki", "knowledge base", "guide", "manual", "writing"]],
  index: ["Index", "Paper", "dark", ["docs", "reference", "api reference", "index", "glossary", "table of contents", "specification"]],
  horizon: ["Horizon", "Calm", "light", ["strategy", "vision", "mission", "planning", "okrs", "annual plan", "goals", "future"]],
};

// The first twelve, tagged for auto covers too (general-purpose; a few fit a theme well).
export const BASE_TAGS = {
  mist: ["light", ["notes", "general", "writing", "journal", "draft", "personal", "minimal"]],
  linen: ["light", ["notes", "writing", "journal", "personal", "essay", "reading", "book"]],
  graphite: ["dark", ["notes", "general", "engineering", "minimal", "archive"]],
  fold: ["light", ["product", "brief", "proposal", "pitch", "overview", "announcement"]],
  halftone: ["light", ["marketing", "brand", "campaign", "press", "launch", "social"]],
  dusk: ["dark", ["release", "launch", "vision", "keynote", "kickoff", "milestone"]],
  contour: ["light", ["research", "exploration", "discovery", "strategy", "analysis", "travel"]],
  blueprint: ["dark", ["engineering", "architecture", "design doc", "rfc", "technical spec", "system design"]],
  strata: ["dark", ["data", "pipeline", "infrastructure", "systems", "performance", "observability"]],
  dawn: ["light", ["onboarding", "welcome", "new", "kickoff", "introduction", "morning"]],
  sage: ["light", ["people", "wellbeing", "health", "hr", "sustainability", "garden", "calm"]],
  moonlit: ["dark", ["retro", "reflection", "postmortem", "night", "review", "quiet"]],
};

export function themed({ Canvas, perlin, fbm, rng, smooth, W, H }) {
  const svgOf = (body, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs}</defs>${body}</svg>`;
  const f1 = (v) => v.toFixed(1);
  // Light paper: cool mist, brighter top-left, a touch deeper bottom-right, a soft formation.
  const light = (seed, { base = "#E8ECF1", hi = "#F4F6F9", lo = "#D9DFE7", warm = null } = {}) => {
    const c = new Canvas().fill(base);
    c.mix(hi, Canvas.blob(260, -20, 980, 420));
    c.mix(lo, (x, y) => 0.55 * smooth(0.3, 1.15, (x / W) * 0.6 + (y / H) * 0.5));
    if (warm) c.mix(warm, Canvas.blob(1180, 520, 900, 260));
    const n = fbm(perlin(seed), 3);
    c.scale((x, y) => 1 + 0.018 * n(x / 420, y / 180));
    return c;
  };
  // Night ink: deep blue-black with a lifted area where the motif sits.
  const dark = (seed, { base = "#0E1524", hi = "#172340", at = [1050, 200] } = {}) => {
    const c = new Canvas().fill(base);
    c.mix(hi, Canvas.blob(at[0], at[1], 980, 400));
    c.mix("#0A101C", (x, y) => 0.5 * smooth(0.35, 1.2, (1 - x / W) * 0.45 + (y / H) * 0.6));
    const n = fbm(perlin(seed), 3);
    c.scale((x, y) => 1 + 0.05 * n(x / 380, y / 200));
    return c;
  };
  const shadow = (id, sd = 14, op = 0.18) =>
    `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
  const glow = (id, sd) => `<filter id="${id}" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
  const fadeLeft = (id, from = 0.25, to = 0.65) =>
    `<linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="0"><stop offset="${from}" stop-color="#fff" stop-opacity="0"/><stop offset="${to}" stop-color="#fff" stop-opacity="1"/></linearGradient>
     <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#${id}g)"/></mask>`;

  return {
    // ── Product ────────────────────────────────────────────────────────────
    async facets() {
      // Three cards stacked in isometric space, the top one carrying an accent strip.
      const c = light(101);
      const cx = 1060, cy = 250, k = Math.cos(Math.PI / 6), s = 0.5;
      const P = (x, y, z) => [cx + (x - y) * k, cy + (x + y) * s - z];
      const quad = (x0, y0, w, h, z) => [P(x0, y0, z), P(x0 + w, y0, z), P(x0 + w, y0 + h, z), P(x0, y0 + h, z)];
      const pts = (q) => q.map((p) => p.map(f1).join(",")).join(" ");
      const cards = [[-150, -120, 300, 230, -10], [-150, -120, 300, 230, 46], [-150, -120, 300, 230, 102]];
      let body = "";
      cards.forEach(([x, y, w, h, z], i) => {
        const q = quad(x, y, w, h, z);
        const sh = quad(x + 14, y + 14, w, h, z - 26);
        body += `<polygon points="${pts(sh)}" fill="#1B2F6B" opacity="${0.1 + i * 0.02}" filter="url(#sh)"/>`;
        body += `<polygon points="${pts(q)}" fill="${["#DCE3EE", "#EEF2F8", "#FFFFFF"][i]}" stroke="#C3CDDC" stroke-width="1"/>`;
        // the card's edge thickness
        const e = [P(x, y + h, z), P(x + w, y + h, z), P(x + w, y + h, z - 8), P(x, y + h, z - 8)];
        const e2 = [P(x + w, y, z), P(x + w, y + h, z), P(x + w, y + h, z - 8), P(x + w, y, z - 8)];
        body += `<polygon points="${pts(e)}" fill="#C9D2E0"/><polygon points="${pts(e2)}" fill="#B7C3D6"/>`;
      });
      const [x, y, , , z] = cards[2];
      body += `<polygon points="${pts(quad(x + 26, y + 26, 120, 18, z))}" fill="#2150D8"/>`;
      for (let i = 0; i < 4; i++) body += `<polygon points="${pts(quad(x + 26, y + 70 + i * 30, [220, 180, 200, 120][i], 9, z))}" fill="#D3DAE6"/>`;
      body += `<polygon points="${pts(quad(x + 190, y + 26, 84, 18, z))}" fill="#E4E9F2"/>`;
      await c.svg(svgOf(body, shadow("sh", 16)));
      return c.bytes({ grain: 0.008, grainScale: 1.2, seed: 101 });
    },
    async prism() {
      // A beam of light through a prism, fanning into three blues, on ink.
      const c = dark(102, { at: [980, 240] });
      const A = [880, 110], B = [1040, 390], C = [720, 390];
      const hit = [800, 250], out = [960, 250];
      const body = `
        <line x1="0" y1="330" x2="${hit[0]}" y2="${hit[1]}" stroke="#DDE5F8" stroke-opacity=".55" stroke-width="2.2" filter="url(#soft)"/>
        <line x1="0" y1="330" x2="${hit[0]}" y2="${hit[1]}" stroke="#FFFFFF" stroke-opacity=".7" stroke-width="1"/>
        <g mask="url(#fan)"><polygon points="${out[0]},${out[1] - 6} ${W},150 ${W},235" fill="#3A5FD9" opacity=".6"/>
        <polygon points="${out[0]},${out[1]} ${W},235 ${W},318" fill="#5B7FE6" opacity=".52"/>
        <polygon points="${out[0]},${out[1] + 6} ${W},318 ${W},405" fill="#8FA6EE" opacity=".42"/></g>
        <polygon points="${hit[0]},${hit[1]} ${out[0]},${out[1] - 6} ${out[0]},${out[1] + 6}" fill="#C8D4F6" opacity=".55"/>
        <polygon points="${A.join(",")} ${B.join(",")} ${C.join(",")}" fill="url(#glass)" stroke="#AFC0F0" stroke-opacity=".55" stroke-width="1.2"/>
        <line x1="${A[0]}" y1="${A[1]}" x2="${(B[0] + C[0]) / 2}" y2="${B[1]}" stroke="#FFFFFF" stroke-opacity=".08"/>`;
      const defs = `<linearGradient id="fang" x1="0" y1="0" x2="1" y2="0"><stop offset=".62" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".35"/></linearGradient><mask id="fan" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#fang)"/></mask><linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2A3E7E" stop-opacity=".55"/><stop offset="1" stop-color="#16224A" stop-opacity=".35"/></linearGradient>${glow("soft", 3)}`;
      await c.svg(svgOf(body, defs));
      c.add("#2150D8", (x, y) => 0.05 * Canvas.blob(1250, 280, 420, 200)(x, y));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 102 });
    },

    // ── Engineering ────────────────────────────────────────────────────────
    async circuit() {
      // Traces with 45° jogs and round pads, denser to the right.
      const c = light(103);
      const r = rng(103);
      let paths = "", pads = "", accent = "";
      for (let k = 0; k < 24; k++) {
        const y0 = 18 + k * 19.5 + (r() - 0.5) * 6;
        let x = W + 10, y = y0, d = `M${x} ${f1(y)}`;
        const stop = 520 + r() * 520;
        while (x > stop) {
          const run = 60 + r() * 180;
          x -= run;
          d += `H${f1(x)}`;
          if (r() < 0.45 && x > stop + 40) {
            const dy = (r() < 0.5 ? -1 : 1) * 19.5;
            x -= Math.abs(dy);
            y += dy;
            d += `L${f1(x)} ${f1(y)}`;
          }
        }
        const isA = k === 9 || k === 16;
        (isA ? (accent += `<path d="${d}"/>`) : (paths += `<path d="${d}"/>`));
        pads += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${isA ? 4.2 : 3.4}" fill="${isA ? "#2150D8" : "#F4F6F9"}" stroke="${isA ? "#2150D8" : "#93A3BA"}" stroke-width="1.2"/>`;
      }
      // a few chips: rounded squares the traces run under
      const chips = [[1180, 150, 120, 84], [930, 300, 84, 64]].map(([x, y, w, h]) =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#F7F8FA" stroke="#A9B6C9" stroke-width="1.2"/><rect x="${x + 14}" y="${y + 14}" width="${w - 28}" height="${h - 28}" rx="4" fill="none" stroke="#C9D2DF" stroke-width="1"/>`).join("");
      const body = `<g mask="url(#fade)"><g fill="none" stroke="#A3B1C6" stroke-width="1.2" stroke-linejoin="round">${paths}</g>
        <g fill="none" stroke="#2150D8" stroke-opacity=".75" stroke-width="1.5" stroke-linejoin="round">${accent}</g>${pads}${chips}</g>`;
      await c.svg(svgOf(body, fadeLeft("fade", 0.22, 0.6)));
      return c.bytes({ grain: 0.005, seed: 103 });
    },

    // ── Release ────────────────────────────────────────────────────────────
    async ascent() {
      // A dotted trajectory rising to an accent point, over a warm low horizon.
      const c = light(104, { warm: "#F4E3D3" });
      c.mix("#FBF1E6", Canvas.blob(1150, 470, 520, 120, 0, 1.3));
      const pts = [];
      for (let t = 0; t <= 1.0001; t += 0.025) {
        const x = 560 + t * 720, y = 430 - Math.pow(t, 1.9) * 320;
        pts.push([x, y]);
      }
      const dots = pts.map(([x, y], i) => `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(1.4 + (i / pts.length) * 2.2)}" fill="#5873C9" fill-opacity="${(0.25 + (i / pts.length) * 0.55).toFixed(2)}"/>`).join("");
      const [ex, ey] = pts[pts.length - 1];
      const body = `
        <g fill="none" stroke="#9AA9C4" stroke-opacity=".35"><circle cx="${ex}" cy="${ey}" r="70"/><circle cx="${ex}" cy="${ey}" r="130" stroke-opacity=".2"/><circle cx="${ex}" cy="${ey}" r="200" stroke-opacity=".12"/></g>
        ${dots}
        <circle cx="${ex}" cy="${ey}" r="26" fill="#2150D8" opacity=".25" filter="url(#g)"/>
        <circle cx="${ex}" cy="${ey}" r="9" fill="#2150D8"/><circle cx="${ex}" cy="${ey}" r="3.2" fill="#FFFFFF"/>`;
      await c.svg(svgOf(body, glow("g", 12)));
      return c.bytes({ grain: 0.008, grainScale: 1.4, seed: 104 });
    },

    // ── Meetings ───────────────────────────────────────────────────────────
    async circles() {
      // Overlapping translucent discs: several voices, one conversation.
      const c = light(105);
      const discs = [[930, 250, 190, "#BCCCF0", 0.75], [1150, 200, 170, "#F2D6C3", 0.7], [1110, 360, 150, "#CBD9CC", 0.72], [1330, 330, 130, "#C9D3E3", 0.8]];
      const body = discs.map(([x, y, r, col, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}" fill-opacity="${o}"/>`).join("")
        + discs.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#FFFFFF" stroke-opacity=".7" stroke-width="1.2"/>`).join("")
        + `<circle cx="1062" cy="268" r="5" fill="#2150D8"/>`;
      await c.svg(svgOf(`<g style="mix-blend-mode:multiply">${body}</g>`));
      return c.bytes({ grain: 0.007, grainScale: 1.3, seed: 105 });
    },
    async orbit() {
      // Tilted orbits around a quiet centre, a few bodies on them.
      const c = dark(106, { at: [1080, 240] });
      const cx = 1080, cy = 240;
      let body = "";
      const r = rng(106);
      [110, 175, 245, 320, 400].forEach((a, i) => {
        body += `<ellipse cx="${cx}" cy="${cy}" rx="${a}" ry="${f1(a * 0.38)}" transform="rotate(-14 ${cx} ${cy})" fill="none" stroke="#C9D3E3" stroke-opacity="${(0.3 - i * 0.04).toFixed(2)}" stroke-width="1.1"/>`;
        const t = r() * Math.PI * 2, rot = (-14 * Math.PI) / 180;
        const ex = a * Math.cos(t), ey = a * 0.38 * Math.sin(t);
        const px = cx + ex * Math.cos(rot) - ey * Math.sin(rot), py = cy + ex * Math.sin(rot) + ey * Math.cos(rot);
        body += `<circle cx="${f1(px)}" cy="${f1(py)}" r="${i === 2 ? 6 : 3.4}" fill="${i === 2 ? "#5B7FE6" : "#DDE5F8"}" fill-opacity="${i === 2 ? 1 : 0.8}"/>`;
      });
      body += `<circle cx="${cx}" cy="${cy}" r="34" fill="#6F86CC" opacity=".35" filter="url(#g)"/><circle cx="${cx}" cy="${cy}" r="13" fill="#DDE5F8"/>`;
      await c.svg(svgOf(body, glow("g", 16)));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 106 });
    },

    // ── Research ───────────────────────────────────────────────────────────
    async constellation() {
      // Star dust, and a handful of brighter stars joined into a figure.
      const c = dark(107, { base: "#0C1220", at: [1000, 180] });
      const r = rng(107);
      let dust = "";
      for (let i = 0; i < 420; i++) {
        const x = r() * W, y = r() * H, b = r();
        const fade = Math.min(1, x / W + 0.25);
        dust += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${(0.4 + b * 0.9).toFixed(2)}" fill="#DDE5F8" fill-opacity="${(0.08 + b * 0.35 * fade).toFixed(2)}"/>`;
      }
      const stars = [[780, 330], [880, 250], [1010, 285], [1105, 175], [1230, 205], [1300, 120], [1190, 330], [1340, 300]];
      const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [2, 6], [6, 7], [4, 7]];
      const lines = edges.map(([a, b]) => `<line x1="${stars[a][0]}" y1="${stars[a][1]}" x2="${stars[b][0]}" y2="${stars[b][1]}"/>`).join("");
      const bright = stars.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 3 ? 4.2 : 2.6}" fill="${i === 3 ? "#8FA6EE" : "#F2F5FC"}"/>`).join("");
      const halo = `<circle cx="${stars[3][0]}" cy="${stars[3][1]}" r="22" fill="#5B7FE6" opacity=".45" filter="url(#g)"/>`;
      await c.svg(svgOf(`${dust}<g stroke="#C9D3E3" stroke-opacity=".32" stroke-width="1">${lines}</g>${halo}${bright}`, glow("g", 10)));
      return c.bytes({ grain: 0.01, grainScale: 1.4, seed: 107 });
    },

    // ── Design ─────────────────────────────────────────────────────────────
    async swatches() {
      // Palette cards fanned out from one corner.
      const c = light(108, { base: "#EAEDF1" });
      const cols = ["#111A2C", "#2150D8", "#8FA6EE", "#CBD9CC", "#F2D6C3", "#E9E3D8"];
      const px = 1200, py = 640;
      let body = "";
      cols.forEach((col, i) => {
        const a = -38 + i * 13;
        const card = `<g transform="rotate(${a} ${px} ${py})"><rect x="${px - 62}" y="${py - 520}" width="124" height="400" rx="14" fill="#1B2F6B" opacity=".14" filter="url(#sh)" transform="translate(6 10)"/>
          <rect x="${px - 62}" y="${py - 520}" width="124" height="400" rx="14" fill="#FFFFFF" stroke="#D3DAE6"/>
          <rect x="${px - 50}" y="${py - 508}" width="100" height="150" rx="8" fill="${col}"/>
          <rect x="${px - 50}" y="${py - 340}" width="64" height="8" rx="4" fill="#D3DAE6"/><rect x="${px - 50}" y="${py - 322}" width="40" height="8" rx="4" fill="#E4E9F1"/></g>`;
        body += card;
      });
      await c.svg(svgOf(body, shadow("sh", 10)));
      return c.bytes({ grain: 0.006, grainScale: 1.2, seed: 108 });
    },
    async bezier() {
      // Curves with their handles and anchors, as a drawing tool shows them.
      const c = dark(109, { at: [1000, 240] });
      const curves = [
        { d: [[560, 380], [760, 380], [820, 120], [1020, 140]], col: "#C9D3E3", op: 0.5 },
        { d: [[1020, 140], [1220, 160], [1180, 400], [1440, 330]], col: "#C9D3E3", op: 0.5 },
        { d: [[700, 120], [900, 40], [1000, 420], [1300, 230]], col: "#5B7FE6", op: 0.95 },
      ];
      let body = "";
      for (const { d, col, op } of curves) {
        const [p0, c1, c2, p1] = d;
        body += `<path d="M${p0} C${c1} ${c2} ${p1}" fill="none" stroke="${col}" stroke-opacity="${op}" stroke-width="${col === "#5B7FE6" ? 2 : 1.3}"/>`;
      }
      const [p0, c1, c2, p1] = curves[2].d;
      body += `<g stroke="#8FA6EE" stroke-opacity=".6" stroke-width="1"><line x1="${p0[0]}" y1="${p0[1]}" x2="${c1[0]}" y2="${c1[1]}"/><line x1="${p1[0]}" y1="${p1[1]}" x2="${c2[0]}" y2="${c2[1]}"/></g>`;
      body += [c1, c2].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.5" fill="#0E1524" stroke="#8FA6EE" stroke-width="1.3"/>`).join("");
      body += [p0, p1, [1020, 140]].map(([x, y]) => `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" fill="#0E1524" stroke="#DDE5F8" stroke-width="1.3"/>`).join("");
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 109 });
    },

    // ── Ops ────────────────────────────────────────────────────────────────
    async pulse() {
      // A monitor trace over fine chart paper: steady, one calm beat.
      const c = light(110);
      let minor = "", major = "";
      for (let x = 0; x <= W; x += 20) (x % 100 === 0 ? (major += `M${x + 0.5} 0V${H}`) : (minor += `M${x + 0.5} 0V${H}`));
      for (let y = 0; y <= H; y += 20) (y % 100 === 0 ? (major += `M0 ${y + 0.5}H${W}`) : (minor += `M0 ${y + 0.5}H${W}`));
      const base = 280;
      let d = `M0 ${base}`;
      for (let x = 0; x <= W; x += 4) {
        let y = base + 2.2 * Math.sin(x / 37);
        const u = x - 1060;
        if (u > -40 && u < 120) {
          y -= 150 * Math.exp(-(((u - 20) / 9) ** 2)) - 46 * Math.exp(-(((u - 46) / 10) ** 2)) - 18 * Math.exp(-(((u + 26) / 12) ** 2)) * -1;
          y += 26 * Math.exp(-(((u - 80) / 22) ** 2));
        }
        d += `L${x} ${f1(y)}`;
      }
      const body = `<path d="${minor}" stroke="#2150D8" stroke-opacity=".05"/><path d="${major}" stroke="#2150D8" stroke-opacity=".1"/>
        <g mask="url(#fade)"><path d="${d}" fill="none" stroke="#2150D8" stroke-width="2.2" stroke-linejoin="round" stroke-opacity=".85"/></g>
        <circle cx="${W - 60}" cy="${base}" r="16" fill="#2150D8" opacity=".25" filter="url(#g)"/><circle cx="${W - 60}" cy="${base}" r="5" fill="#2150D8"/>`;
      await c.svg(svgOf(body, fadeLeft("fade", 0.0, 0.45) + glow("g", 8)));
      return c.bytes({ grain: 0.004, seed: 110 });
    },
    async terminal() {
      // Log lines as quiet dashes; a few in the accent, one cursor.
      const c = dark(111, { base: "#0D1320", at: [1100, 220] });
      const r = rng(111);
      let body = "";
      const x0 = 700, lh = 24;
      let y = 46;
      for (let row = 0; row < 17; row++, y += lh) {
        let x = x0 + (r() < 0.25 ? 28 : 0);
        body += `<rect x="${x}" y="${y}" width="28" height="7" rx="3.5" fill="#5B6B86" fill-opacity=".55"/>`;
        x += 40;
        const n = 2 + Math.floor(r() * 4);
        for (let k = 0; k < n && x < W - 40; k++) {
          const w = 30 + r() * 150;
          const kind = r();
          const col = kind < 0.12 ? "#5B7FE6" : kind < 0.2 ? "#7FB59A" : "#C9D3E3";
          const op = col === "#C9D3E3" ? 0.18 + r() * 0.2 : 0.8;
          body += `<rect x="${f1(x)}" y="${y}" width="${f1(Math.min(w, W - 30 - x))}" height="7" rx="3.5" fill="${col}" fill-opacity="${op.toFixed(2)}"/>`;
          x += w + 12;
        }
      }
      body += `<rect x="${x0}" y="${y - 2}" width="12" height="16" rx="2" fill="#8FA6EE"/>`;
      await c.svg(svgOf(`<g mask="url(#fade)">${body}</g>`, fadeLeft("fade", 0.42, 0.62)));
      return c.bytes({ grain: 0.01, grainScale: 1.3, seed: 111 });
    },

    // ── People ─────────────────────────────────────────────────────────────
    async gather() {
      // A small crowd of soft figures: heads and shoulders in warm, quiet tones.
      const c = light(112, { base: "#ECE8E2", hi: "#F7F4EF", lo: "#E0D9CE" });
      const cols = ["#E8C9B2", "#C9D6CB", "#C3CFEA", "#E5D7BF", "#D9C5D0", "#B9C9E8", "#D3DCC6"];
      const r = rng(112);
      const figs = [];
      for (let i = 0; i < 11; i++) {
        const row = i < 5 ? 0 : 1;
        const x = 760 + (row ? 60 : 0) + (i % (row ? 6 : 5)) * (row ? 118 : 140) + (r() - 0.5) * 30;
        const s = (row ? 1.06 : 0.86) * (0.9 + r() * 0.2);
        const y = row ? 530 : 455;
        figs.push({ x, y, s, col: cols[i % cols.length], row, o: row ? 0.95 : 0.55 });
      }
      figs[7].col = "#7F9BE3";  // one of them in the accent's softer blue
      figs.sort((a, b) => a.row - b.row);
      const body = figs.map(({ x, y, s, col, o }) => {
        const hr = 34 * s, bw = 120 * s, bh = 150 * s, hy = y - bh - hr * 0.95;
        return `<g opacity="${o}"><circle cx="${f1(x)}" cy="${f1(hy)}" r="${f1(hr)}" fill="${col}"/>
          <path d="M${f1(x - bw / 2)} ${f1(y)} V${f1(y - bh + bw / 2)} A${f1(bw / 2)} ${f1(bw / 2)} 0 0 1 ${f1(x + bw / 2)} ${f1(y - bh + bw / 2)} V${f1(y)} Z" fill="${col}"/></g>`;
      }).join("");
      await c.svg(svgOf(`<g opacity=".92">${body}</g>`));
      return c.bytes({ grain: 0.007, grainScale: 1.3, seed: 112 });
    },
    async lanterns() {
      // Warm lights drifting up through a blue night.
      const c = dark(113, { base: "#0D1426", hi: "#1A2648", at: [1050, 300] });
      const r = rng(113);
      let near = "", far = "";
      for (let i = 0; i < 42; i++) {
        const x = 540 + r() * 960, y = 40 + r() * 420, depth = r();
        const rad = 1.6 + depth * 4.4;
        const o = (0.35 + depth * 0.6) * Math.min(1, (x - 540) / 320);
        const halo = `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(rad * 6)}" fill="url(#halo)" opacity="${(o * 0.8).toFixed(2)}"/>`;
        const dot = `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(rad)}" fill="#F7D6A8" fill-opacity="${o.toFixed(2)}"/>`;
        (depth > 0.6 ? (near += halo + dot) : (far += halo + dot));
      }
      const defs = `<radialGradient id="halo"><stop offset="0" stop-color="#F2B56B" stop-opacity=".55"/><stop offset=".35" stop-color="#F2B56B" stop-opacity=".18"/><stop offset="1" stop-color="#F2B56B" stop-opacity="0"/></radialGradient>${glow("b1", 1.4)}`;
      await c.svg(svgOf(`<g filter="url(#b1)">${far}</g>${near}`, defs));
      c.add("#F2B56B", (x, y) => 0.025 * Canvas.blob(1100, 380, 600, 200)(x, y));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 113 });
    },

    // ── Finance ────────────────────────────────────────────────────────────
    async ledger() {
      // Ruled ledger paper with a double margin rule and quiet bars rising.
      const c = light(114, { base: "#EEF0F2", hi: "#F8F9FA", lo: "#E1E5EA" });
      let rules = "";
      for (let y = 36; y < H; y += 28) rules += `M0 ${y + 0.5}H${W}`;
      let cols = "";
      for (const x of [980, 1110, 1240, 1370]) cols += `M${x + 0.5} 0V${H}`;
      const bars = [140, 175, 160, 215, 250, 236, 290, 330].map((h, i) => `<rect x="${1000 + i * 54}" y="${430 - h}" width="34" height="${h}" rx="4" fill="${i === 7 ? "#2150D8" : "#B9C7E2"}" fill-opacity="${i === 7 ? 0.85 : 0.6}"/>`).join("");
      const body = `<path d="${rules}" stroke="#7E93B8" stroke-opacity=".22" stroke-width="1"/>
        <path d="${cols}" stroke="#7E93B8" stroke-opacity=".14"/>
        <path d="M860.5 0V${H}M866.5 0V${H}" stroke="#2150D8" stroke-opacity=".35"/>${bars}`;
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.006, grainScale: 1.2, seed: 114 });
    },
    async columns() {
      // Rounded bars climbing out of the dark, a thin trend line above them.
      const c = dark(115, { base: "#0E1630", hi: "#13204A", at: [1150, 420] });
      const n = 13, x0 = 760, step = 54;
      const hs = [90, 110, 104, 140, 132, 170, 190, 182, 220, 250, 238, 290, 330];
      let bars = "", line = "";
      hs.forEach((h, i) => {
        const x = x0 + i * step, t = i / (n - 1);
        bars += `<rect x="${x}" y="${440 - h}" width="34" height="${h + 60}" rx="8" fill="url(#bar)" opacity="${(0.45 + 0.55 * t).toFixed(2)}"/>`;
        line += `${i ? "L" : "M"}${x + 17} ${440 - h - 26}`;
      });
      const defs = `<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6383E2"/><stop offset="1" stop-color="#1C3178" stop-opacity=".2"/></linearGradient>`;
      await c.svg(svgOf(`${bars}<path d="${line}" fill="none" stroke="#DDE5F8" stroke-opacity=".55" stroke-width="1.4" stroke-dasharray="2 6" stroke-linecap="round"/><circle cx="${x0 + 12 * step + 17}" cy="${440 - 330 - 26}" r="4.5" fill="#DDE5F8"/>`, defs));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 115 });
    },

    // ── Marketing ──────────────────────────────────────────────────────────
    async signal() {
      // Arcs going out from one point: a message, travelling.
      const c = dark(116, { at: [1200, 260] });
      const cx = 1290, cy = 270;
      let arcs = "";
      for (let i = 1; i <= 14; i++) {
        const r = i * 44;
        const a0 = Math.PI * (1 - 0.23), a1 = Math.PI * (1 + 0.23);
        const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
        const op = (0.5 - i * 0.03).toFixed(2);
        arcs += `<path d="M${f1(p0[0])} ${f1(p0[1])}A${r} ${r} 0 0 1 ${f1(p1[0])} ${f1(p1[1])}" fill="none" stroke="${i === 5 ? "#5B7FE6" : "#C9D3E3"}" stroke-opacity="${i === 5 ? 0.9 : op}" stroke-width="${i === 5 ? 2 : 1.2}" stroke-linecap="round"/>`;
      }
      await c.svg(svgOf(`${arcs}<circle cx="${cx}" cy="${cy}" r="30" fill="#5B7FE6" opacity=".4" filter="url(#g)"/><circle cx="${cx}" cy="${cy}" r="8" fill="#DDE5F8"/>`, glow("g", 14)));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 116 });
    },
    async confetti() {
      // A light scatter of small shapes: something worth celebrating, said quietly.
      const c = light(117);
      const r = rng(117);
      const cols = ["#2150D8", "#8FA6EE", "#E8B89A", "#A9C2AE", "#C3CFEA", "#E5D3A8"];
      let body = "";
      for (let i = 0; i < 70; i++) {
        let x = 560 + Math.pow(r(), 0.7) * 940, y = r() * H;
        const col = cols[Math.floor(r() * cols.length)], a = r() * 180, kind = r();
        const o = (0.55 + r() * 0.4) * Math.min(1, (x - 560) / 260);
        if (kind < 0.35) body += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(3 + r() * 4)}" fill="${col}" fill-opacity="${o.toFixed(2)}"/>`;
        else if (kind < 0.7) body += `<rect x="${f1(x - 9)}" y="${f1(y - 3.5)}" width="18" height="7" rx="3.5" fill="${col}" fill-opacity="${o.toFixed(2)}" transform="rotate(${f1(a)} ${f1(x)} ${f1(y)})"/>`;
        else if (kind < 0.85) body += `<path d="M${f1(x - 8)} ${f1(y + 6)}L${f1(x)} ${f1(y - 8)}L${f1(x + 8)} ${f1(y + 6)}Z" fill="${col}" fill-opacity="${o.toFixed(2)}" transform="rotate(${f1(a)} ${f1(x)} ${f1(y)})"/>`;
        else body += `<path d="M${f1(x - 14)} ${f1(y)}q7 -9 14 0t14 0" fill="none" stroke="${col}" stroke-opacity="${o.toFixed(2)}" stroke-width="2.4" stroke-linecap="round" transform="rotate(${f1(a)} ${f1(x)} ${f1(y)})"/>`;
      }
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.006, grainScale: 1.2, seed: 117 });
    },

    // ── Legal ──────────────────────────────────────────────────────────────
    async seal() {
      // Laid paper with a blind-embossed rosette: a guilloche pattern, light from the top-left.
      const c = light(118, { base: "#ECE7DE", hi: "#F7F4EE", lo: "#DED6C8" });
      const cx = 1150, cy = 240;
      let ros = "";
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        ros += `<circle cx="${f1(cx + 62 * Math.cos(a))}" cy="${f1(cy + 62 * Math.sin(a))}" r="120"/>`;
      }
      let rays = "";
      for (let k = 0; k < 120; k++) {
        const a = (k / 120) * Math.PI * 2;
        rays += `M${f1(cx + 196 * Math.cos(a))} ${f1(cy + 196 * Math.sin(a))}L${f1(cx + 206 * Math.cos(a))} ${f1(cy + 206 * Math.sin(a))}`;
      }
      const emboss = (dx, dy, col, op) => `<g transform="translate(${dx} ${dy})" fill="none" stroke="${col}" stroke-opacity="${op}" stroke-width="1">${ros}<circle cx="${cx}" cy="${cy}" r="186"/><circle cx="${cx}" cy="${cy}" r="214"/><path d="${rays}"/></g>`;
      let laid = "";
      for (let y = 0; y < H; y += 4) laid += `M0 ${y + 0.5}H${W}`;
      const body = `<path d="${laid}" stroke="#B9AD98" stroke-opacity=".08"/>${emboss(1.2, 1.2, "#FFFFFF", 0.75)}${emboss(0, 0, "#A89A84", 0.38)}`;
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.008, grainScale: 1.2, seed: 118 });
    },
    async pillars() {
      // A colonnade abstracted to shaded bands with fine flutes.
      const c = dark(119, { base: "#0E1524", hi: "#18264A", at: [1080, 160] });
      let body = "";
      for (let i = 0; i < 7; i++) {
        const x = 690 + i * 116, w = 66;
        body += `<rect x="${x}" y="70" width="${w}" height="380" fill="url(#col)"/>`;
        for (let k = 1; k < 6; k++) body += `<line x1="${x + k * (w / 6)}" y1="74" x2="${x + k * (w / 6)}" y2="446" stroke="#0E1524" stroke-opacity=".35"/>`;
        body += `<rect x="${x - 8}" y="56" width="${w + 16}" height="14" rx="2" fill="#8FA6EE" fill-opacity=".35"/><rect x="${x - 8}" y="450" width="${w + 16}" height="12" rx="2" fill="#8FA6EE" fill-opacity=".25"/>`;
      }
      body += `<rect x="660" y="36" width="${W - 640}" height="14" fill="#8FA6EE" fill-opacity=".28"/>`;
      const defs = `<linearGradient id="col" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3B55A8" stop-opacity=".35"/><stop offset=".35" stop-color="#8FA6EE" stop-opacity=".55"/><stop offset="1" stop-color="#1C3178" stop-opacity=".25"/></linearGradient>`;
      await c.svg(svgOf(`<g mask="url(#fade)">${body}</g>`, defs + fadeLeft("fade", 0.4, 0.62)));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 119 });
    },

    // ── Support ────────────────────────────────────────────────────────────
    async bubbles() {
      // Two speech bubbles in a calm exchange; the reply is typing.
      const c = light(120);
      const bubble = (x, y, w, h, tail, fill, stroke) => {
        const t = tail === "l" ? `M${x + 30} ${y + h}l-14 22l40 -22z` : `M${x + w - 30} ${y + h}l14 22l-40 -22z`;
        return `<g><rect x="${x + 6}" y="${y + 12}" width="${w}" height="${h}" rx="26" fill="#1B2F6B" opacity=".12" filter="url(#sh)"/>
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="${fill}" stroke="${stroke}"/><path d="${t}" fill="${fill}"/></g>`;
      };
      let body = bubble(800, 70, 380, 150, "l", "#FFFFFF", "#D3DAE6");
      body += [[836, 116, 250], [836, 146, 300], [836, 176, 170]].map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="10" rx="5" fill="#D9DFE9"/>`).join("");
      body += bubble(1050, 270, 260, 110, "r", "#2150D8", "#2150D8");
      body += [0, 1, 2].map((i) => `<circle cx="${1140 + i * 40}" cy="325" r="8" fill="#FFFFFF" fill-opacity="${(0.95 - i * 0.25).toFixed(2)}"/>`).join("");
      await c.svg(svgOf(body, shadow("sh", 14)));
      return c.bytes({ grain: 0.006, grainScale: 1.2, seed: 120 });
    },
    async beacon() {
      // A soft beam sweeping across a dark sky from a small light low on the right.
      const c = dark(121, { base: "#0B1120", hi: "#141F3C", at: [1200, 320] });
      const sx = 1260, sy = 380;
      c.add("#8FA6EE", (x, y) => {
        const dx = x - sx, dy = y - sy;
        const ang = Math.atan2(dy, dx), dist = Math.hypot(dx, dy);
        const target = -2.82; // up and to the left
        const d = Math.abs(((ang - target + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        return 0.13 * Math.exp(-((d / 0.16) ** 2)) * Math.exp(-dist / 900) * smooth(0, 60, dist);
      });
      c.add("#DDE5F8", (x, y) => 0.25 * Math.exp(-(((x - sx) ** 2 + (y - sy) ** 2) / 220)));
      c.add("#5B7FE6", (x, y) => 0.08 * Math.exp(-(((x - sx) ** 2) / 9000 + ((y - sy) ** 2) / 2500)));
      c.mix("#070B15", (x, y) => 0.6 * smooth(395, 480, y));
      await c.svg(svgOf(`<line x1="0" y1="395.5" x2="${W}" y2="395.5" stroke="#8FA6EE" stroke-opacity=".18"/>`));
      return c.bytes({ grain: 0.014, grainScale: 1.5, seed: 121 });
    },

    // ── Data ───────────────────────────────────────────────────────────────
    async scatter() {
      // Points around a rising curve, its confidence band shaded.
      const c = light(122);
      const r = rng(122);
      const f = (x) => 380 - 230 / (1 + Math.exp(-(x - 1060) / 120));
      let band = `M600 ${f1(f(600) - 46)}`, low = "";
      for (let x = 600; x <= W; x += 10) band += `L${x} ${f1(f(x) - 46 - (x - 600) * 0.02)}`;
      for (let x = W; x >= 600; x -= 10) low += `L${x} ${f1(f(x) + 46 + (x - 600) * 0.02)}`;
      let pts = "";
      for (let i = 0; i < 170; i++) {
        const x = 560 + r() * 940, y = f(x) + (r() + r() + r() - 1.5) * 70;
        const o = Math.min(1, (x - 560) / 240);
        pts += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(2.4 + r() * 1.6)}" fill="#5873C9" fill-opacity="${(0.55 * o).toFixed(2)}"/>`;
      }
      let curve = "";
      for (let x = 600; x <= W; x += 6) curve += `${x === 600 ? "M" : "L"}${x} ${f1(f(x))}`;
      const body = `<path d="M580 450H${W}M580.5 40V450" stroke="#93A2B8" stroke-opacity=".5"/>
        <path d="${band}${low}Z" fill="#8FA6EE" fill-opacity=".18"/>${pts}
        <path d="${curve}" fill="none" stroke="#2150D8" stroke-width="2.2"/>`;
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.005, seed: 122 });
    },
    async heatmap() {
      // A grid of rounded cells, quiet to bright, like a year of activity.
      const c = dark(123, { at: [1100, 240] });
      const n = fbm(perlin(123), 3);
      const steps = ["#16213F", "#1C3178", "#2746AA", "#4467D6", "#8FA6EE"];
      let body = "";
      const cell = 22, gap = 6, rows = 7, x0 = 640, y0 = 140;
      for (let i = 0; x0 + i * (cell + gap) < W - 20; i++) {
        for (let j = 0; j < rows; j++) {
          const x = x0 + i * (cell + gap), y = y0 + j * (cell + gap);
          const v = 0.5 + n(i / 6, j / 3) * 1.2 + (i / 30) * 0.4;
          const k = Math.max(0, Math.min(4, Math.floor(v * 4.2)));
          const o = Math.min(1, (x - x0) / 200 + 0.15);
          body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="5" fill="${steps[k]}" fill-opacity="${o.toFixed(2)}"/>`;
        }
      }
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.01, grainScale: 1.3, seed: 123 });
    },

    // ── Security ───────────────────────────────────────────────────────────
    async lattice() {
      // A hexagonal lattice that firms up to the right; a few cells sealed in the accent.
      const c = light(124);
      const R = 34, w = Math.sqrt(3) * R;
      const r = rng(124);
      let grid = "", fill = "";
      for (let row = -1; row * 1.5 * R < H + R; row++) {
        for (let col = -1; col * w < W + w; col++) {
          const cx = col * w + (row % 2 ? w / 2 : 0), cy = row * 1.5 * R;
          if (cx < 480) continue;
          const pts = Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 6 + (k * Math.PI) / 3; return `${f1(cx + R * Math.cos(a))},${f1(cy + R * Math.sin(a))}`; }).join(" ");
          grid += `<polygon points="${pts}"/>`;
          if (cx > 950 && r() < 0.09) fill += `<polygon points="${pts}" fill="${r() < 0.4 ? "#2150D8" : "#B9C7E2"}" fill-opacity="${r() < 0.4 ? 0.8 : 0.6}"/>`;
        }
      }
      await c.svg(svgOf(`<g mask="url(#fade)"><g fill="none" stroke="#93A3BA" stroke-width="1.1">${grid}</g>${fill}</g>`, fadeLeft("fade", 0.33, 0.75)));
      return c.bytes({ grain: 0.005, seed: 124 });
    },
    async vault() {
      // A vault dial: rings, fine ticks and one marker, catching a little light.
      const c = dark(125, { at: [1120, 240] });
      const cx = 1120, cy = 240;
      let ticks = "";
      for (let k = 0; k < 100; k++) {
        const a = (k / 100) * Math.PI * 2, r1 = 170, r2 = k % 10 === 0 ? 150 : 160;
        ticks += `M${f1(cx + r1 * Math.cos(a))} ${f1(cy + r1 * Math.sin(a))}L${f1(cx + r2 * Math.cos(a))} ${f1(cy + r2 * Math.sin(a))}`;
      }
      let spokes = "";
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
        spokes += `<line x1="${cx}" y1="${cy}" x2="${f1(cx + 92 * Math.cos(a))}" y2="${f1(cy + 92 * Math.sin(a))}" stroke="#C9D3E3" stroke-opacity=".45" stroke-width="7" stroke-linecap="round"/>`;
      }
      const body = `<circle cx="${cx}" cy="${cy}" r="214" fill="none" stroke="#C9D3E3" stroke-opacity=".14" stroke-width="18"/>
        <circle cx="${cx}" cy="${cy}" r="190" fill="#121C34" stroke="#C9D3E3" stroke-opacity=".3"/>
        <path d="${ticks}" stroke="#DDE5F8" stroke-opacity=".5"/>
        <circle cx="${cx}" cy="${cy}" r="128" fill="none" stroke="#C9D3E3" stroke-opacity=".22"/>${spokes}
        <circle cx="${cx}" cy="${cy}" r="30" fill="#1C2A4E" stroke="#8FA6EE" stroke-opacity=".7" stroke-width="1.4"/>
        <path d="M${cx} ${cy - 236}l-9 -16h18z" fill="#5B7FE6"/>
        <circle cx="${cx}" cy="${cy}" r="214" fill="none" stroke="url(#sheen)" stroke-width="2"/>`;
      const defs = `<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#DDE5F8" stop-opacity=".6"/><stop offset=".5" stop-color="#DDE5F8" stop-opacity="0"/></linearGradient>`;
      await c.svg(svgOf(body, defs));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 125 });
    },

    // ── Roadmap ────────────────────────────────────────────────────────────
    async route() {
      // A winding dotted route with milestones; the last one reached.
      const c = light(126, { warm: "#EFE6DA" });
      const P = [[480, 420], [700, 390], [850, 270], [1000, 300], [1110, 380], [1250, 330], [1330, 190], [1420, 130]];
      // A Catmull-Rom spline through the points: one smooth, unhurried line.
      let d = `M${P[0]}`;
      for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `C${c1.map(f1).join(" ")} ${c2.map(f1).join(" ")} ${p2.join(" ")}`;
      }
      const ms = [P[2], P[4], P[6]];
      const body = `<path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="10" stroke-linecap="round" stroke-opacity=".7"/>
        <path d="${d}" fill="none" stroke="#7E8FB0" stroke-width="2.2" stroke-dasharray="1 9" stroke-linecap="round"/>
        ${ms.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="11" fill="#FFFFFF" stroke="#93A3BA" stroke-width="2"/>`).join("")}
        <circle cx="${P[7][0]}" cy="${P[7][1]}" r="22" fill="#2150D8" opacity=".2" filter="url(#g)"/>
        <circle cx="${P[7][0]}" cy="${P[7][1]}" r="11" fill="#2150D8"/><circle cx="${P[7][0]}" cy="${P[7][1]}" r="4" fill="#FFFFFF"/>`;
      await c.svg(svgOf(`<g mask="url(#fade)">${body}</g>`, fadeLeft("fade", 0.3, 0.52) + glow("g", 10)));
      return c.bytes({ grain: 0.007, grainScale: 1.3, seed: 126 });
    },
    async waypoints() {
      // A timeline: a line of nodes, with tracks branching off and merging back.
      const c = dark(127, { at: [1050, 240] });
      const y = 250, xs = [700, 840, 980, 1120, 1260, 1400];
      const body = `<line x1="560" y1="${y}" x2="${W}" y2="${y}" stroke="#C9D3E3" stroke-opacity=".35" stroke-width="1.4"/>
        <path d="M840 ${y}C900 ${y} 900 ${y - 90} 960 ${y - 90}H1120C1180 ${y - 90} 1180 ${y} 1240 ${y}" fill="none" stroke="#5B7FE6" stroke-width="1.8"/>
        <path d="M980 ${y}C1040 ${y} 1040 ${y + 80} 1100 ${y + 80}H1200C1260 ${y + 80} 1260 ${y} 1320 ${y}" fill="none" stroke="#C9D3E3" stroke-opacity=".3" stroke-width="1.4"/>
        ${xs.map((x, i) => `<circle cx="${x}" cy="${y}" r="${i === 3 ? 9 : 7}" fill="#0E1524" stroke="${i < 4 ? "#DDE5F8" : "#5B6B86"}" stroke-width="2"/>${i < 3 ? `<circle cx="${x}" cy="${y}" r="3" fill="#DDE5F8"/>` : ""}`).join("")}
        <circle cx="1040" cy="${y - 90}" r="5" fill="#5B7FE6"/>
        ${xs.map((x) => `<line x1="${x}" y1="${y + 30}" x2="${x}" y2="${y + 150}" stroke="#C9D3E3" stroke-opacity=".08" stroke-dasharray="2 5"/>`).join("")}`;
      await c.svg(svgOf(`<g mask="url(#fade)">${body}</g>`, fadeLeft("fade", 0.34, 0.5)));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 127 });
    },

    // ── Retro ──────────────────────────────────────────────────────────────
    async tide() {
      // Long, low waves layered towards the shore.
      const c = light(128, { base: "#E4E9F0", hi: "#F3F5F8" });
      const layers = [["#D5DDE9", 250, 16], ["#C6D2E4", 300, 14], ["#B5C5DE", 345, 12], ["#A5B8D8", 388, 10], ["#93A9D2", 430, 8]];
      const n = perlin(128);
      let body = "";
      layers.forEach(([col, base, amp], i) => {
        let d = `M0 ${H}L0 ${base}`;
        for (let x = 0; x <= W; x += 6) d += `L${x} ${f1(base + amp * Math.sin(x / (180 - i * 18) + i * 1.3) + 10 * n(x / 300, i * 2.1))}`;
        d += `L${W} ${H}Z`;
        body += `<path d="${d}" fill="${col}"/>`;
        let crest = `M0 ${base}`;
        for (let x = 0; x <= W; x += 6) crest += `L${x} ${f1(base + amp * Math.sin(x / (180 - i * 18) + i * 1.3) + 10 * n(x / 300, i * 2.1))}`;
        body += `<path d="${crest}" fill="none" stroke="#FFFFFF" stroke-opacity=".55" stroke-width="1.2"/>`;
      });
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.007, grainScale: 1.4, seed: 128 });
    },

    // ── Onboarding ─────────────────────────────────────────────────────────
    async doorway() {
      // An open, arched doorway with warm light falling out onto the floor.
      const c = light(129, { base: "#E2E7EE", hi: "#EEF1F5", lo: "#D3DAE4" });
      const x = 1040, w = 170, top = 60, floor = 400;
      const body = `<path d="M0 ${floor}.5H${W}" stroke="#B8C3D3" stroke-opacity=".6"/>
        <path d="M${x} ${floor}L${x - 140} ${H}H${x + w + 260}L${x + w} ${floor}Z" fill="url(#spill)"/>
        <path d="M${x} ${floor}V${top + w / 2}A${w / 2} ${w / 2} 0 0 1 ${x + w} ${top + w / 2}V${floor}Z" fill="url(#light)"/>
        <path d="M${x} ${floor}V${top + w / 2}A${w / 2} ${w / 2} 0 0 1 ${x + w} ${top + w / 2}V${floor}" fill="none" stroke="#C9D2DF" stroke-width="10"/>
        <path d="M${x + w} ${floor}V${top + w / 2}" stroke="#FFFFFF" stroke-opacity=".6" stroke-width="2"/>`;
      const defs = `<linearGradient id="light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF7EE"/><stop offset="1" stop-color="#F6DCC4"/></linearGradient>
        <linearGradient id="spill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6DCC4" stop-opacity=".9"/><stop offset="1" stop-color="#F6DCC4" stop-opacity="0"/></linearGradient>`;
      await c.svg(svgOf(body, defs));
      c.add("#F4D9C0", (px, py) => 0.08 * Canvas.blob(x + w / 2, 260, 260, 220)(px, py));
      return c.bytes({ grain: 0.007, grainScale: 1.3, seed: 129 });
    },

    // ── Docs ───────────────────────────────────────────────────────────────
    async sheets() {
      // A few sheets of paper, fanned slightly; the top one carries ruled lines of writing.
      const c = light(130);
      const sheet = (x, y, a, fill) => `<g transform="rotate(${a} ${x + 150} ${y + 200})"><rect x="${x + 8}" y="${y + 14}" width="300" height="400" rx="6" fill="#1B2F6B" opacity=".12" filter="url(#sh)"/><rect x="${x}" y="${y}" width="300" height="400" rx="6" fill="${fill}" stroke="#D3DAE6"/></g>`;
      let body = sheet(1060, 40, 9, "#EEF1F6") + sheet(1000, 50, 4, "#F5F7FA") + sheet(940, 60, -2, "#FFFFFF");
      const lines = [[52, 160, "#2150D8"], [90, 230, "#D3DAE6"], [112, 200, "#D3DAE6"], [134, 236, "#D3DAE6"], [156, 120, "#D3DAE6"], [194, 210, "#D3DAE6"], [216, 236, "#D3DAE6"], [238, 180, "#D3DAE6"], [276, 150, "#E2E7EF"], [298, 220, "#E2E7EF"]];
      body += `<g transform="rotate(-2 1090 260)">${lines.map(([dy, w, col], i) => `<rect x="${972}" y="${60 + dy}" width="${w}" height="${i === 0 ? 14 : 8}" rx="${i === 0 ? 7 : 4}" fill="${col}"/>`).join("")}</g>`;
      await c.svg(svgOf(body, shadow("sh", 12)));
      return c.bytes({ grain: 0.006, grainScale: 1.2, seed: 130 });
    },
    async index() {
      // A contents page in the dark: entries, dot leaders, page marks.
      const c = dark(131, { at: [1100, 220] });
      const r = rng(131);
      let body = "", y = 70;
      for (let i = 0; i < 12; i++, y += 30) {
        const sub = i % 4 !== 0;
        const x = sub ? 760 : 730, w = sub ? 90 + r() * 140 : 160 + r() * 80;
        const on = i === 5;
        body += `<rect x="${x}" y="${y}" width="${f1(w)}" height="${sub ? 7 : 9}" rx="4" fill="${on ? "#5B7FE6" : "#C9D3E3"}" fill-opacity="${on ? 0.95 : sub ? 0.28 : 0.5}"/>`;
        body += `<line x1="${f1(x + w + 14)}" y1="${y + 5}" x2="1360" y2="${y + 5}" stroke="#C9D3E3" stroke-opacity="${sub ? 0.18 : 0.26}" stroke-width="1.6" stroke-dasharray="0.1 8" stroke-linecap="round"/>`;
        body += `<rect x="1376" y="${y}" width="${sub ? 18 : 24}" height="${sub ? 7 : 9}" rx="3.5" fill="#C9D3E3" fill-opacity="${sub ? 0.28 : 0.45}"/>`;
      }
      await c.svg(svgOf(`<g mask="url(#fade)">${body}</g>`, fadeLeft("fade", 0.4, 0.56)));
      return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 131 });
    },

    // ── Strategy ───────────────────────────────────────────────────────────
    async horizon() {
      // Ridges fading into the distance under a pale sun: the long view.
      const c = light(132, { base: "#E3E8EF", hi: "#F2F4F8" });
      c.mix("#F8EFE4", Canvas.blob(1080, 210, 360, 150));
      c.add("#FFFFFF", (x, y) => 0.25 * Math.exp(-(((x - 1080) ** 2 + (y - 210) ** 2) / 3600)));
      const n = fbm(perlin(132), 4);
      const ridges = [["#D6DDE8", 270, 60], ["#C6D0DF", 315, 70], ["#B3C0D6", 360, 70], ["#9DAECC", 405, 60], ["#8799BF", 445, 40]];
      let body = "";
      ridges.forEach(([col, base, amp], i) => {
        let d = `M0 ${H}`;
        for (let x = 0; x <= W; x += 5) d += `L${x} ${f1(base - amp * (0.5 + n(x / (520 - i * 60), i * 3.7)) * smooth(0, 1, 0.3 + x / W))}`;
        body += `<path d="${d}L${W} ${H}Z" fill="${col}"/>`;
      });
      await c.svg(svgOf(body));
      return c.bytes({ grain: 0.007, grainScale: 1.4, seed: 132 });
    },
  };
}
