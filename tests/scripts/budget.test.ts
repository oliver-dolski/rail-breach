import { describe, expect, it } from "vitest";
import {
  BASELINE_CSS_BYTES,
  BASELINE_JS_BYTES,
  budgetVerdict,
  CSS_GROWTH_BYTES,
  FONT_BYTES,
  JS_GROWTH_BYTES,
} from "../../scripts/check-budget.mjs";

describe("the size budget of dist/ (UI-SPEC G16)", () => {
  it("pins the baseline of 8680694 and the growth the phase may spend", () => {
    expect(BASELINE_JS_BYTES).toBe(213_980);
    expect(BASELINE_CSS_BYTES).toBe(11_204);
    expect(JS_GROWTH_BYTES).toBe(40_960);
    expect(CSS_GROWTH_BYTES).toBe(8_192);
    expect(FONT_BYTES).toBe(22_288);
  });

  it("accepts a build exactly at the limits with the one pinned font", () => {
    const verdict = budgetVerdict({
      js: BASELINE_JS_BYTES + JS_GROWTH_BYTES,
      css: BASELINE_CSS_BYTES + CSS_GROWTH_BYTES,
      fonts: [FONT_BYTES],
    });
    expect(verdict).toEqual({ ok: true, reasons: [] });
    expect(budgetVerdict({ js: 254_940, css: 19_396, fonts: [22_288] }).ok).toBe(true);
  });

  it("refuses one byte more JavaScript and names it", () => {
    const verdict = budgetVerdict({
      js: BASELINE_JS_BYTES + JS_GROWTH_BYTES + 1,
      css: BASELINE_CSS_BYTES,
      fonts: [FONT_BYTES],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/JavaScript/);
  });

  it("refuses one byte more CSS and names it", () => {
    const verdict = budgetVerdict({
      js: BASELINE_JS_BYTES,
      css: BASELINE_CSS_BYTES + CSS_GROWTH_BYTES + 1,
      fonts: [FONT_BYTES],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/CSS/);
  });

  it("refuses a second font file and a font of another size", () => {
    const base = { js: BASELINE_JS_BYTES, css: BASELINE_CSS_BYTES };
    const two = budgetVerdict({ ...base, fonts: [FONT_BYTES, 1000] });
    expect(two.ok).toBe(false);
    expect(two.reasons.join(" ")).toMatch(/font/i);
    const other = budgetVerdict({ ...base, fonts: [FONT_BYTES + 1] });
    expect(other.ok).toBe(false);
    expect(other.reasons.join(" ")).toMatch(/font/i);
    const none = budgetVerdict({ ...base, fonts: [] });
    expect(none.ok).toBe(false);
  });

  it("lists every reason when several limits are broken", () => {
    const verdict = budgetVerdict({ js: 10_000_000, css: 10_000_000, fonts: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toHaveLength(3);
  });
});
