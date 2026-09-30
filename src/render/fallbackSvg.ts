import type { Layout, Pt } from "../content/layout";
import type { Content } from "../content/types";
import { ALERT_COLORS, cssColor, NEUTRAL, type Rgb, SIGNAL_COLORS } from "./palette";

/**
 * Builds the static still that replaces the live map when WebGL2 is missing: the
 * same sheet, drawn once in SVG at a moment mid-attack. public/fallback.svg is
 * generated from this (npm run fallback:regen) and a test fails if they drift.
 */

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (n: number): string => String(Math.round(n * 10) / 10);

const path = (pts: readonly Pt[]): string => pts.map((p) => `${num(p.x)},${num(p.y)}`).join(" ");

/** Machines shown as compromised, lost or in flight in the still. */
const STILL = {
  compromised: ["corp-ws-dispatch", "dmz-relay", "dispatch-hmi-1"],
  lost: ["tms-server"],
  proceedSignals: ["S-HAR-dn", "S-DUN-up", "S-L4-dn"],
  trains: [
    { block: "L2_dn", at: 0.55 },
    { block: "L3_up", at: 0.4 },
    { block: "BR_up", at: 0.25 },
  ],
} as const;

function glyph(
  kind: "ring" | "diamond" | "cross",
  x: number,
  y: number,
  r: number,
  color: Rgb,
): string {
  const c = cssColor(color);
  if (kind === "diamond") {
    const pts = `${num(x)},${num(y - r * 1.15)} ${num(x + r * 1.15)},${num(y)} ${num(x)},${num(y + r * 1.15)} ${num(x - r * 1.15)},${num(y)}`;
    return `<polygon points="${pts}" fill="${c}" filter="url(#glow)"/>`;
  }
  if (kind === "cross") {
    const d = r * 0.95;
    return (
      `<g stroke="${c}" stroke-width="${num(r * 0.6)}" stroke-linecap="round" filter="url(#glow)">` +
      `<line x1="${num(x - d)}" y1="${num(y - d)}" x2="${num(x + d)}" y2="${num(y + d)}"/>` +
      `<line x1="${num(x - d)}" y1="${num(y + d)}" x2="${num(x + d)}" y2="${num(y - d)}"/></g>`
    );
  }
  return `<circle cx="${num(x)}" cy="${num(y)}" r="${num(r * 0.72)}" fill="none" stroke="${c}" stroke-width="${num(r * 0.5)}"/>`;
}

export function buildFallbackSvg(layout: Layout, content: Content): string {
  const out: string[] = [];
  const add = (s: string): void => {
    out.push(s);
  };
  add(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img">`,
  );
  add("<title>Rail Breach: schematic dispatcher map of a fictional railway (still image)</title>");
  add(
    '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>',
  );
  add(
    `<rect width="${layout.width}" height="${layout.height}" fill="${cssColor(NEUTRAL.background)}"/>`,
  );

  for (const z of layout.zones) {
    add(
      `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="none" stroke="${cssColor(NEUTRAL.zone)}" stroke-width="1.4" stroke-dasharray="9 7"/>`,
    );
    add(
      `<text x="${z.x + 8}" y="${z.y + 16}" fill="${cssColor(NEUTRAL.zoneLabel)}" font-family="monospace" font-size="11" letter-spacing="1.5">${esc(z.label)}</text>`,
    );
  }

  for (const link of content.links) {
    const a = layout.nodes[link.a];
    const b = layout.nodes[link.b];
    if (!a || !b) continue;
    add(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${cssColor(NEUTRAL.link)}" stroke-width="${link.conduit ? 2 : 1.4}"/>`,
    );
  }

  const seen = new Set<string>();
  for (const block of content.tracks.blocks) {
    if (seen.has(block.section)) continue;
    seen.add(block.section);
    const pts = layout.blocks[block.id];
    if (!pts) continue;
    add(
      `<polyline points="${path(pts)}" fill="none" stroke="${cssColor(NEUTRAL.track)}" stroke-width="${block.lengthDm <= 5000 ? 9 : 5}" stroke-linecap="butt" stroke-linejoin="round"/>`,
    );
  }
  for (const c of layout.connectors) {
    add(
      `<polyline points="${path(c)}" fill="none" stroke="${cssColor(NEUTRAL.track)}" stroke-width="4"/>`,
    );
  }

  for (const t of STILL.trains) {
    const pts = layout.blocks[t.block];
    const a = pts?.[0];
    const b = pts?.[pts.length - 1];
    if (!a || !b) continue;
    const x = a.x + (b.x - a.x) * t.at;
    const y = a.y + (b.y - a.y) * t.at;
    const ux = Math.sign(b.x - a.x) * 9;
    add(
      `<line x1="${num(x - ux)}" y1="${num(y)}" x2="${num(x + ux)}" y2="${num(y)}" stroke="${cssColor(NEUTRAL.train)}" stroke-width="7" stroke-linecap="round" filter="url(#glow)"/>`,
    );
  }

  for (const signal of content.tracks.signals) {
    const pts = layout.blocks[signal.block];
    const end = pts?.[pts.length - 1];
    const prev = pts?.[pts.length - 2];
    if (!end || !prev) continue;
    const len = Math.hypot(end.x - prev.x, end.y - prev.y) || 1;
    const dx = (end.x - prev.x) / len;
    const dy = (end.y - prev.y) / len;
    const stop = !(STILL.proceedSignals as readonly string[]).includes(signal.id);
    const color = stop ? SIGNAL_COLORS.stop : SIGNAL_COLORS.proceed;
    add(
      `<circle cx="${num(end.x - dy * 14)}" cy="${num(end.y + dx * 14)}" r="4.6" fill="${cssColor(color)}" filter="url(#glow)"/>`,
    );
  }

  for (const [id, n] of Object.entries(layout.nodes)) {
    const r = id === "tms-server" ? 10 : 7.5;
    if ((STILL.lost as readonly string[]).includes(id)) {
      add(glyph("cross", n.x, n.y, r, ALERT_COLORS.impact));
    } else if ((STILL.compromised as readonly string[]).includes(id)) {
      add(glyph("diamond", n.x, n.y, r, ALERT_COLORS.attacker));
    } else {
      add(glyph("ring", n.x, n.y, r, NEUTRAL.node));
    }
    add(
      `<text x="${n.x}" y="${n.y + 26}" fill="${cssColor(NEUTRAL.nodeLabel)}" font-family="monospace" font-size="10.5" text-anchor="middle">${esc(n.label)}</text>`,
    );
  }

  for (const s of layout.stations) {
    add(
      `<text x="${s.x}" y="${s.y + 4}" fill="${cssColor(NEUTRAL.nodeLabel)}" font-family="monospace" font-size="12" text-anchor="middle">${esc(s.name)}</text>`,
    );
  }

  add(
    `<text x="24" y="${layout.height - 7}" fill="${cssColor(NEUTRAL.zoneLabel)}" font-family="monospace" font-size="12">Still image. Fictional network and railway. A phishing chain reaches the traffic management server; the interlockings refuse new routes and trains stop at red signals.</text>`,
  );
  add("</svg>");
  return `${out.join("\n")}\n`;
}
