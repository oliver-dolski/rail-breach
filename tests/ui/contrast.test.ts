import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/ui/style.css", "utf8");

/** The value of a custom property on :root. */
function token(name: string): string {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const value = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(root)?.[1];
  if (value === undefined) throw new Error(`no colour token ${name}`);
  return value;
}

/** The colour declared by the rule whose selector is exactly `selector`. */
function ruleColour(selector: string): string {
  const flat = css.replace(/\s+/g, " ");
  const start = flat.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const body = flat.slice(flat.indexOf("{", start) + 1, flat.indexOf("}", start));
  const value = /(?:^|[\s;])color:\s*(#[0-9a-fA-F]{6})/.exec(body)?.[1];
  if (value === undefined) throw new Error(`${selector} has no hex colour`);
  return value;
}

/** WCAG 2.x relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const GROUND = "#07090d";
const PANEL = "#0b0f15";
/** What a glow lifts the ground to under a map label. */
const LIFTED = "#1a2230";
const MIN = 4.5;

describe("text contrast (UI-SPEC gate G2)", () => {
  it("measures with the WCAG formula: black on white is 21:1", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("body and muted text reach 4.5:1 on the stage and the panel", () => {
    for (const name of ["--text", "--muted"]) {
      for (const ground of [GROUND, PANEL]) {
        expect(contrast(token(name), ground), `${name} on ${ground}`).toBeGreaterThanOrEqual(MIN);
      }
    }
  });

  it("every map label colour reaches 4.5:1 on the ground, the panel and a glow-lifted ground", () => {
    for (const selector of [".lbl-zone", ".lbl-node", ".lbl-conduit", ".lbl-station"]) {
      const colour = ruleColour(selector);
      for (const ground of [GROUND, PANEL, LIFTED]) {
        expect(
          contrast(colour, ground),
          `${selector} ${colour} on ${ground}`,
        ).toBeGreaterThanOrEqual(MIN);
      }
    }
  });

  it("gives every map label a dark halo so bloom does not wash the text out", () => {
    const flat = css.replace(/\s+/g, " ");
    const lbl = /\.lbl \{([^}]*)\}/.exec(flat)?.[1] ?? "";
    expect(lbl).toContain("text-shadow: 0 0 4px rgba(7, 9, 13, 0.95), 0 0 8px rgba(7, 9, 13, 0.8)");
  });
});
