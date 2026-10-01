import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import {
  boxesOverlap,
  cssScale,
  LABEL_STYLES,
  type LabelKind,
  labelCollisions,
  placeLabels,
} from "../../src/render/labelgeometry";
import { createViewContext } from "../../src/render/view";
import { networkIndex } from "../fixtures/attack";

const ctx = createViewContext(network, networkIndex(), layout);
const marks = ctx.conduitMarks;

/** The canvases the page can show, in CSS pixels: the map stage at each page width. */
const CANVASES = {
  "the capture size (1280 x 720 page)": { w: 1280 - 340, h: 720 },
  "a 1600 px wide page": { w: 1600 - 340, h: 900 },
  "an 820 px wide page (one column, 16:9 canvas)": { w: 820, h: (820 * 9) / 16 },
};

describe("label styles", () => {
  const css = readFileSync("src/ui/style.css", "utf8");
  const rule = (name: string): string => {
    const match = new RegExp(`.lbl-${name} {([^}]*)}`).exec(css);
    if (!match) throw new Error(`style.css has no .lbl-${name} rule`);
    return match[1] ?? "";
  };

  it.each(Object.keys(LABEL_STYLES) as LabelKind[])(
    "the %s style in labelgeometry is the one style.css sets",
    (kind) => {
      const body = rule(kind);
      const size =
        /font-size:\s*max\((\d+(?:\.\d+)?)px,\s*calc\(var\(--u\)\s*\*\s*(\d+(?:\.\d+)?)px\)\)/.exec(
          body,
        );
      expect(size, `${kind} font-size`).not.toBeNull();
      const spacing = /letter-spacing:\s*(\d+(?:\.\d+)?)em/.exec(body);
      expect({
        floor: Number(size?.[1]),
        size: Number(size?.[2]),
        spacing: spacing ? Number(spacing[1]) : 0,
      }).toEqual(LABEL_STYLES[kind]);
    },
  );
});

describe("the map labels never collide", () => {
  it("knows the scales it is testing: the stage fits the sheet by its smaller side", () => {
    expect(cssScale(940, 720, layout)).toBeCloseTo(0.5875, 4);
    expect(cssScale(1260, 900, layout)).toBeCloseTo(0.7875, 4);
    expect(cssScale(820, 461.25, layout)).toBeCloseTo(0.5125, 4);
  });

  for (const [name, canvas] of Object.entries(CANVASES)) {
    it(`has no label on another label, a zone border, a node glyph or a track at ${name}`, () => {
      expect(labelCollisions(layout, marks, cssScale(canvas.w, canvas.h, layout))).toEqual([]);
    });
  }

  it("holds at every map scale from the narrowest page to a large screen, where the text floor makes labels biggest", () => {
    const bad: string[] = [];
    for (let u = 0.5; u <= 1.1001; u += 0.01) {
      for (const clash of labelCollisions(layout, marks, u))
        bad.push(`u ${u.toFixed(2)}: ${clash}`);
    }
    expect(bad).toEqual([]);
  });

  it("covers every node, every station, every zone and every conduit caption", () => {
    const placed = placeLabels(layout, marks, 0.5875);
    const ids = (kind: LabelKind): string[] =>
      placed.filter((p) => p.kind === kind).map((p) => p.id);
    expect(ids("node").sort()).toEqual(Object.keys(layout.nodes).sort());
    expect(ids("station").sort()).toEqual(layout.stations.map((s) => s.name).sort());
    expect(ids("zone").sort()).toEqual(layout.zones.map((z) => z.id).sort());
    expect(ids("conduit").sort()).toEqual(network.conduits.map((c) => c.id).sort());
  });

  it("would notice the old placement: a caption in the middle of its link lands on the label above it", () => {
    const old = marks.map((m) => {
      if (!m.id.endsWith("-way")) return m;
      const link = ctx.linkById.get(m.link);
      if (!link) throw new Error(m.link);
      return { ...m, x: (link.a.x + link.b.x) / 2, y: (link.a.y + link.b.y) / 2 };
    });
    const clashes = labelCollisions(layout, old, cssScale(940, 720, layout));
    expect(clashes.some((c) => c.includes("c-tav-way"))).toBe(true);
  });

  it("detects two overlapping labels and a label on a zone border", () => {
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(boxesOverlap(a, { x0: 9, y0: 9, x1: 20, y1: 20 })).toBe(true);
    expect(boxesOverlap(a, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBe(false);
    const onBorder = marks.map((m) =>
      m.id === "c-net-corp"
        ? { ...m, x: layout.zones[0] ? layout.zones[0].x + layout.zones[0].w : 150 }
        : m,
    );
    expect(
      labelCollisions(layout, onBorder, 0.5875).some((c) => c.includes("border of z-internet")),
    ).toBe(true);
  });
});

describe("conduit spots", () => {
  it("each names a link of its own conduit and a fraction along it", () => {
    for (const [id, spot] of Object.entries(layout.conduitSpots)) {
      const link = network.links.find((l) => l.id === spot.link);
      expect(link?.conduit, id).toBe(id);
      expect(spot.at, id).toBeGreaterThan(0);
      expect(spot.at, id).toBeLessThan(1);
    }
  });

  it("puts the caption at the spot, on that link", () => {
    for (const mark of marks) {
      const spot = layout.conduitSpots[mark.id];
      if (!spot) continue;
      expect(mark.link).toBe(spot.link);
      const link = ctx.linkById.get(spot.link);
      expect(mark.x).toBeCloseTo(
        (link?.a.x ?? 0) + ((link?.b.x ?? 0) - (link?.a.x ?? 0)) * spot.at,
        6,
      );
      expect(mark.y).toBeCloseTo(
        (link?.a.y ?? 0) + ((link?.b.y ?? 0) - (link?.a.y ?? 0)) * spot.at,
        6,
      );
    }
  });
});
