import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/ui/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  body: string;
}

/** Every innermost rule, including those inside @media; @font-face is left out. */
function rules(): Rule[] {
  const found: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] as string).trim().replace(/\s+/g, " ");
    if (selector.startsWith("@")) continue;
    found.push({ selector, body: m[2] as string });
  }
  return found;
}

/** Map labels, the still and the legend glyphs are outside the panel scale. */
const EXEMPT = /\.lbl-|\.fallback|\.glyph/;

describe("the panel type scale (UI-SPEC Typography)", () => {
  const panelRules = rules().filter((r) => !EXEMPT.test(r.selector));

  it("finds the rules it is meant to check", () => {
    expect(panelRules.length).toBeGreaterThan(40);
    expect(panelRules.some((r) => /font-size/.test(r.body))).toBe(true);
  });

  it("uses only 11, 13, 16 and 20 px or the matching tokens", () => {
    const ok = /^(11px|13px|16px|20px|var\(--fs-(label|body|heading|display)\))$/;
    for (const rule of panelRules) {
      for (const m of rule.body.matchAll(/font-size:\s*([^;]+);/g)) {
        expect((m[1] as string).trim(), `${rule.selector} font-size`).toMatch(ok);
      }
    }
  });

  it("uses only the weights 400 and 600", () => {
    for (const rule of panelRules) {
      for (const m of rule.body.matchAll(/font-weight:\s*([^;]+);/g)) {
        expect((m[1] as string).trim(), `${rule.selector} font-weight`).toMatch(/^(400|600)$/);
      }
    }
  });

  it("declares the four sizes as tokens", () => {
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(root).toMatch(/--fs-label:\s*11px/);
    expect(root).toMatch(/--fs-body:\s*13px/);
    expect(root).toMatch(/--fs-heading:\s*16px/);
    expect(root).toMatch(/--fs-display:\s*20px/);
  });

  it("keeps the 4 px spacing scale and the three radii as tokens", () => {
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const [name, value] of [
      ["--space-xs", "4px"],
      ["--space-sm", "8px"],
      ["--space-md", "16px"],
      ["--space-lg", "24px"],
      ["--space-xl", "32px"],
      ["--space-2xl", "48px"],
      ["--radius-card", "8px"],
      ["--radius-control", "4px"],
      ["--radius-pill", "16px"],
    ] as const) {
      expect(root, name).toContain(`${name}: ${value}`);
    }
  });
});
