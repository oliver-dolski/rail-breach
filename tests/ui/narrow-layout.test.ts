import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The body of the first block that opens with `head`, found by matching braces. */
function blockOf(css: string, head: string): string {
  const open = css.indexOf(head);
  if (open < 0) throw new Error(`no ${head} block`);
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", open) + 1, i);
  }
  throw new Error(`unterminated ${head} block`);
}

/** The declarations of the rule in `css` whose selector list is exactly `selector`. */
function ruleOf(css: string, selector: string): string {
  const flat = css.replace(/\s+/g, " ");
  const start = flat.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return flat.slice(flat.indexOf("{", start) + 1, flat.indexOf("}", start));
}

describe("the narrow layout (900 px and below)", () => {
  const css = readFileSync("src/ui/style.css", "utf8");
  const narrow = blockOf(css, "@media (max-width: 900px)");

  it("takes the view switch out of the map and puts it in a row above it", () => {
    const rule = ruleOf(narrow, ".stage > .view-switch");
    expect(rule).toContain("position: static");
    expect(rule).toContain("grid-row: 1");
  });

  it("keeps the canvas, the labels and the still in one cell below the switch", () => {
    const rule = ruleOf(narrow, ".map, .labels, .fallback");
    expect(rule).toContain("grid-row: 2");
    expect(rule).toContain("grid-column: 1");
    expect(rule).toContain("aspect-ratio: 16 / 9");
    expect(rule).toContain("position: relative");
    expect(ruleOf(narrow, ".stage")).toContain("display: grid");
  });

  it("outranks the base rule that floats the switch over the map at every width", () => {
    // The base rule is written after the media block, so only a more specific selector wins.
    const tail = css.slice(css.indexOf(narrow) + narrow.length);
    expect(ruleOf(tail, ".view-switch")).toContain("position: absolute");
    expect(narrow).toContain(".stage > .view-switch");
  });
});
