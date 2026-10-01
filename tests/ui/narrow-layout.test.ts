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

  it("lets the stage controls join row 1 on the right, and wrap", () => {
    const rule = ruleOf(narrow, ".stage > .stage-controls");
    expect(rule).toContain("position: static");
    expect(rule).toContain("grid-row: 1");
    expect(rule).toContain("justify-self: end");
    expect(rule).toContain("flex-wrap: wrap");
  });

  it("makes pills, view switch buttons and the panel controls 44 px high", () => {
    expect(ruleOf(narrow, ".pill, .view-switch .segmented button")).toContain("min-height: 44px");
    expect(
      ruleOf(
        narrow,
        ".field, button.plain, .segmented button, .conduit-list button, .placed button",
      ),
    ).toContain("min-height: 44px");
    expect(ruleOf(narrow, "details.card > summary")).toContain("min-height: var(--space-2xl)");
  });
});

describe("the stage controls (UI-SPEC 4.3)", () => {
  const whole = readFileSync("src/ui/style.css", "utf8");
  // The base rules are written after the narrow block, so look past it.
  const css = whole.slice(
    whole.indexOf("@media (max-width: 900px)") + blockOf(whole, "@media (max-width: 900px)").length,
  );

  it("sits top right with a 16 px inset, on one row on a desktop", () => {
    const rule = ruleOf(css, ".stage-controls");
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("top: var(--space-md)");
    expect(rule).toContain("right: var(--space-md)");
    expect(rule).toContain("display: flex");
    expect(rule).toContain("gap: var(--space-sm)");
    expect(rule).toContain("flex-wrap: nowrap");
  });

  it("is hidden whenever the static fallback is shown", () => {
    const rule = ruleOf(
      css,
      ".fallback:not([hidden]) ~ .stage-controls, .fallback:not([hidden]) ~ .intro-skip",
    );
    expect(rule).toContain("display: none");
  });

  it("draws a pill 32 px high with a 16 px radius on the glass fill", () => {
    const rule = ruleOf(css, ".pill");
    expect(rule).toContain("height: var(--space-xl)");
    expect(rule).toContain("border-radius: var(--radius-pill)");
    expect(rule).toContain("background: var(--pill-bg)");
    expect(rule).toContain("border: 1px solid var(--pill-border)");
    expect(rule).toContain("white-space: nowrap");
    expect(whole).toMatch(/--pill-bg:\s*rgba\(11, 15, 21, 0\.72\)/);
    expect(whole).toMatch(/--pill-border:\s*#263040/);
    expect(whole).toMatch(/--pill-active:\s*#1a2230/);
    expect(whole).toMatch(/--radius-pill:\s*16px/);
  });

  it("marks the pressed pill with a 2 px magenta tick on the left and no outline", () => {
    const rule = ruleOf(css, '.pill[aria-pressed="true"]');
    expect(rule).toContain("inset 2px 0 0 var(--attacker)");
  });

  it("gives the ghost pill a clear fill, a disabled pill muted text, and focus the accent ring", () => {
    expect(ruleOf(css, ".pill.ghost")).toContain("background: transparent");
    expect(ruleOf(css, ".pill:disabled")).toContain("color: var(--muted)");
    const focus = ruleOf(css, ".pill:focus-visible");
    expect(focus).toContain("outline: 2px solid var(--detection)");
    expect(focus).toContain("outline-offset: 1px");
    expect(ruleOf(css, ".pill:hover")).toContain("border-color: var(--detection)");
  });

  it("makes the view switch a glass segmented pill with a filled active segment", () => {
    expect(ruleOf(css, ".view-switch .segmented")).toContain("border-radius: var(--radius-pill)");
    expect(ruleOf(css, ".view-switch .segmented button")).toContain("border: 0");
    const active = ruleOf(css, '.view-switch .segmented button[aria-pressed="true"]');
    expect(active).toContain("background: var(--pill-active)");
    expect(active).toContain("color: #ffffff");
    expect(active).not.toMatch(/outline|border-color/);
    expect(ruleOf(css, ".view-note")).not.toMatch(/background/);
  });

  it("moves nothing on hover in the capture build and under reduced motion", () => {
    expect(whole).toMatch(/:root\[data-capture\] \* \{[^}]*transition: none/);
    const reduced = whole.slice(whole.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("transition: none");
  });
});
