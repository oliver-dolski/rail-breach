import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { fitMap, viewUniform } from "../../src/render/geometry";
import { bridgesToScreen } from "../../src/render/intro/bridges";
import {
  INTRO_LEVEL_NAMES,
  type IntroLevel,
  introLevels,
  levelOfPurdue,
} from "../../src/render/intro/levels";
import { partitionView } from "../../src/render/intro/partition";
import { layerView } from "../../src/render/intro/plates";
import {
  FOLD_END_MS,
  type IntroPose,
  introPose,
  introSheet,
  layerMatrix,
  projectToClip,
} from "../../src/render/intro/pose";
import {
  buildView,
  createViewContext,
  type DiscInstance,
  type LineInstance,
  type PanelInstance,
  type RenderView,
} from "../../src/render/view";
import { networkIndex, warmWorld } from "../fixtures/attack";

const index = networkIndex();
const ctx = createViewContext(network, index, layout);
const levels = introLevels(network, layout);

const LISTS = [
  "panels",
  "links",
  "trail",
  "track",
  "routes",
  "trains",
  "signals",
  "halos",
  "nodes",
  "defenses",
  "defenseArrows",
  "alerts",
] as const;

describe("the five intro levels", () => {
  it("are named exactly as the contract says, top to bottom", () => {
    expect(INTRO_LEVEL_NAMES).toEqual([
      "LEVELS 4-5 AND OUTSIDE",
      "LEVEL 3.5  DMZ",
      "LEVEL 3  CONTROL CENTRE",
      "LEVEL 2  INTERLOCKINGS",
      "LEVEL 1  TRACKSIDE",
    ]);
    expect(levels.map((l) => l.name)).toEqual([...INTRO_LEVEL_NAMES]);
    expect(levels.map((l) => l.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("map the purdue field: ext, 5 and 4 to the first, 3.5, 3, 2 and 1 to one each", () => {
    expect(levelOfPurdue("ext")).toBe(0);
    expect(levelOfPurdue(5)).toBe(0);
    expect(levelOfPurdue(4)).toBe(0);
    expect(levelOfPurdue(3.5)).toBe(1);
    expect(levelOfPurdue(3)).toBe(2);
    expect(levelOfPurdue(2)).toBe(3);
    expect(levelOfPurdue(1)).toBe(4);
  });

  it("throw for a purdue value the table does not know", () => {
    expect(() => levelOfPurdue(0)).toThrow();
  });

  it("hold every layout zone exactly once", () => {
    for (const zone of layout.zones) {
      const holders = levels.filter((l) => l.zoneIds.includes(zone.id));
      expect(holders.length, zone.id).toBe(1);
    }
    expect(levels.flatMap((l) => l.zoneIds).length).toBe(layout.zones.length);
  });

  it("take their zones from the content, not from a list written here", () => {
    const byId = (id: string) => levels.find((l) => l.zoneIds.includes(id))?.index;
    for (const zone of network.zones)
      expect(byId(zone.id), zone.id).toBe(levelOfPurdue(zone.purdue));
    expect(levels[0]?.zoneIds).toEqual(["z-internet", "z-corp", "z-vendor"]);
    expect(levels[3]?.zoneIds).toEqual(["z-il-tav", "z-il-vel", "z-il-cre"]);
  });

  it("refuse a layout zone the content does not know", () => {
    const stray = {
      ...layout,
      zones: [...layout.zones, { id: "z-nowhere", label: "X", x: 0, y: 0, w: 1, h: 1 }],
    };
    expect(() => introLevels(network, stray)).toThrow(/z-nowhere/);
  });

  it("bound their zones with a box and wrap it in a plate across the sheet that stays on it", () => {
    for (const level of levels) {
      const zones = layout.zones.filter((z) => level.zoneIds.includes(z.id));
      expect(level.box.x).toBe(Math.min(...zones.map((z) => z.x)));
      expect(level.box.y).toBe(Math.min(...zones.map((z) => z.y)));
      expect(level.box.x + level.box.w).toBe(Math.max(...zones.map((z) => z.x + z.w)));
      expect(level.box.y + level.box.h).toBe(Math.max(...zones.map((z) => z.y + z.h)));
      expect(level.plate.y).toBeLessThanOrEqual(level.box.y);
      expect(level.plate.y + level.plate.h).toBeGreaterThanOrEqual(level.box.y + level.box.h);
      expect(level.plate.y).toBeGreaterThanOrEqual(0);
      expect(level.plate.y + level.plate.h).toBeLessThanOrEqual(layout.height);
      expect(level.plate.x).toBeLessThanOrEqual(level.box.x);
      expect(level.plate.x + level.plate.w).toBeGreaterThanOrEqual(level.box.x + level.box.w);
    }
  });
});

const zoneOfPoint = (x: number, y: number): string | undefined =>
  layout.zones.find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h)?.id;
const levelOfPoint = (x: number, y: number): number | undefined => {
  const zone = zoneOfPoint(x, y);
  return zone === undefined ? undefined : levels.find((l) => l.zoneIds.includes(zone))?.index;
};

function fullView(): RenderView {
  const view = buildView(warmWorld(index), ctx, {
    trail: [
      { x0: 85, y0: 130, x1: 330, y1: 105, width: 2.6, glow: 8, dash: 0, color: [1, 0, 1, 1] },
    ],
    alerts: [{ link: ctx.links.find((l) => l.conduit !== "")?.id ?? "", level: 1 }],
  });
  // The start of a show has no placed defense; give the lists something to route.
  const glyph = { x: 700, y: 200, radius: 7, shape: 0, glow: 0, color: [1, 1, 1, 1] } as const;
  const arrow = {
    x0: 1,
    y0: 1,
    x1: 2,
    y1: 2,
    width: 1,
    glow: 0,
    dash: 0,
    color: [1, 1, 1, 1],
  } as const;
  return { ...view, defenses: [glyph], defenseArrows: [arrow] };
}

describe("partitionView", () => {
  const view = fullView();
  const parts = partitionView(view, ctx, levels);

  it("gives five layer views and a bridge view, and loses nothing", () => {
    expect(parts.layers.length).toBe(5);
    for (const list of LISTS) {
      const total =
        parts.layers.reduce((n, v) => n + v[list].length, 0) + parts.bridges[list].length;
      expect(total, list).toBe(view[list].length);
      expect(view[list].length, `${list} has something to partition`).toBeGreaterThanOrEqual(
        list === "defenseArrows" || list === "defenses" ? 1 : 0,
      );
    }
    expect(view.nodes.length).toBeGreaterThan(10);
    expect(view.links.length).toBeGreaterThan(10);
  });

  it("reuses the instance objects of the full view", () => {
    const all = new Set<unknown>();
    for (const v of [...parts.layers, parts.bridges])
      for (const list of LISTS) for (const i of v[list]) all.add(i);
    for (const list of LISTS) for (const i of view[list]) expect(all.has(i), list).toBe(true);
  });

  it("puts every node and halo in the level of the zone that contains it", () => {
    for (const layer of parts.layers) {
      const index = parts.layers.indexOf(layer);
      for (const n of [...layer.nodes, ...layer.halos]) expect(levelOfPoint(n.x, n.y)).toBe(index);
    }
    expect(parts.bridges.nodes.length).toBe(0);
    expect(parts.bridges.halos.length).toBe(0);
  });

  it("puts a link with both ends in one zone in that zone's level, and conduits in the bridges", () => {
    const conduits = ctx.links.filter((l) => l.conduit !== "").length;
    expect(parts.bridges.links.length).toBe(conduits);
    expect(conduits).toBeGreaterThan(0);
    for (const layer of parts.layers) {
      const index = parts.layers.indexOf(layer);
      for (const l of layer.links) {
        expect(levelOfPoint(l.x0, l.y0)).toBe(index);
        expect(levelOfPoint(l.x1, l.y1)).toBe(index);
        expect(zoneOfPoint(l.x0, l.y0)).toBe(zoneOfPoint(l.x1, l.y1));
      }
    }
  });

  it("puts track, signals, trains and routes in the last level", () => {
    for (const list of ["track", "signals", "trains", "routes"] as const) {
      for (let i = 0; i < 4; i++) expect(parts.layers[i]?.[list].length, `${list} ${i}`).toBe(0);
      expect(parts.layers[4]?.[list].length, list).toBe(view[list].length);
      expect(parts.bridges[list].length, list).toBe(0);
    }
  });

  it("puts the trail, alerts, defense glyphs and arrows in the bridges", () => {
    for (const list of ["trail", "alerts", "defenses", "defenseArrows"] as const) {
      expect(view[list].length, list).toBeGreaterThan(0);
      expect(parts.bridges[list].length, list).toBe(view[list].length);
      for (const layer of parts.layers) expect(layer[list].length, list).toBe(0);
    }
  });

  it("splits the zone panels one per zone by the level of the zone", () => {
    expect(view.panels.length).toBe(layout.zones.length);
    layout.zones.forEach((zone, i) => {
      const level = levels.find((l) => l.zoneIds.includes(zone.id))?.index ?? -1;
      expect(parts.layers[level]?.panels).toContain(view.panels[i]);
    });
    expect(parts.bridges.panels.length).toBe(0);
  });

  it("draws no ground in a layer", () => {
    for (const v of [...parts.layers, parts.bridges]) expect(v.ground).toBe(false);
  });
});

describe("the plates and the flares", () => {
  const pose = (over: Partial<IntroPose> = {}): IntroPose => ({ ...introPose(1000, 1.6), ...over });

  it("give each layer one plate across its level, and none once the plates are gone", () => {
    const view = partitionView(fullView(), ctx, levels).layers[0] as RenderView;
    const lit = layerView(
      view,
      levels[0] as IntroLevel,
      pose({ plateAlpha: 1, flares: [0, 0, 0, 0, 0] }),
    );
    expect(lit.panels.length).toBe(view.panels.length + 1);
    const plate = lit.panels[0] as PanelInstance;
    expect(plate.x).toBe(levels[0]?.plate.x);
    expect(plate.w).toBe(levels[0]?.plate.w);
    expect(plate.fillTop).toBeGreaterThan(0);

    const gone = layerView(
      view,
      levels[0] as IntroLevel,
      pose({ plateAlpha: 0, flares: [0, 0, 0, 0, 0] }),
    );
    expect(gone.panels).toEqual(view.panels);
    expect(gone.trail.length).toBe(0);
  });

  it("flare a layer's border as lit lines in the attacker colour, and not at all at level 0", () => {
    const view = partitionView(fullView(), ctx, levels).layers[3] as RenderView;
    const level = levels[3] as IntroLevel;
    const quiet = layerView(view, level, pose({ flares: [0, 0, 0, 0, 0] }));
    expect(quiet.trail.length).toBe(0);
    const lit = layerView(view, level, pose({ flares: [0, 0, 0, 0.6, 0] }));
    expect(lit.trail.length).toBe(4);
    for (const line of lit.trail) {
      expect(line.color[3]).toBeCloseTo(0.6, 9);
      expect(line.glow).toBeGreaterThan(0);
    }
    const xs = lit.trail.flatMap((l) => [l.x0, l.x1]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(level.plate.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(level.plate.x + level.plate.w);
  });

  it("keep the layer's own instances, only adding to the front of the panels", () => {
    const view = partitionView(fullView(), ctx, levels).layers[4] as RenderView;
    const lit = layerView(
      view,
      levels[4] as IntroLevel,
      pose({ plateAlpha: 1, flares: [0, 0, 0, 0, 1] }),
    );
    expect(lit.nodes).toBe(view.nodes);
    expect(lit.track).toBe(view.track);
    expect(lit.panels.slice(1)).toEqual(view.panels);
  });
});

describe("the bridges", () => {
  const canvas = { width: 1280, height: 720 };
  const fit = fitMap(canvas.width, canvas.height, layout.width, layout.height);
  const sheet = introSheet(
    levels.map((l) => l.plate),
    layout,
  );
  const parts = partitionView(fullView(), ctx, levels);
  const matricesAt = (t: number) =>
    levels.map((_, i) => layerMatrix(introPose(t, 16 / 9), i, fit, canvas, sheet));

  it("land on the live board at the end of the fold", () => {
    const pose = introPose(FOLD_END_MS, 16 / 9);
    const out = bridgesToScreen(parts.bridges, ctx, levels, matricesAt(FOLD_END_MS), canvas, pose);
    const live = viewUniform(fit, canvas.width, canvas.height);
    const px = (x: number, y: number): [number, number] => [
      ((x * live[0] + live[2] + 1) / 2) * canvas.width,
      ((1 - (y * live[1] + live[3])) / 2) * canvas.height,
    ];
    expect(out.links.length).toBe(parts.bridges.links.length);
    parts.bridges.links.forEach((link, i) => {
      const o = out.links[i] as LineInstance;
      const [x0, y0] = px(link.x0, link.y0);
      const [x1, y1] = px(link.x1, link.y1);
      expect(o.x0).toBeCloseTo(x0, 3);
      expect(o.y0).toBeCloseTo(y0, 3);
      expect(o.x1).toBeCloseTo(x1, 3);
      expect(o.y1).toBeCloseTo(y1, 3);
      expect(o.width).toBeCloseTo(link.width * fit.scale, 3);
    });
    const glyph = parts.bridges.defenses[0] as DiscInstance;
    const g = out.discs[0] as DiscInstance;
    const [gx, gy] = px(glyph.x, glyph.y);
    expect(g.x).toBeCloseTo(gx, 2);
    expect(g.y).toBeCloseTo(gy, 2);
    expect(g.radius).toBeCloseTo(glyph.radius * fit.scale, 3);
  });

  it("join the two layers a conduit connects, whatever the tilt", () => {
    const t = 1500;
    const m = matricesAt(t);
    const out = bridgesToScreen(parts.bridges, ctx, levels, m, canvas, introPose(t, 16 / 9));
    const meta = ctx.links.filter((l) => l.conduit !== "");
    parts.bridges.links.forEach((link, i) => {
      const o = out.links[i] as LineInstance;
      const levelAtPoint = (x: number, y: number) => {
        const zone = layout.zones.find(
          (z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h,
        );
        return levels.findIndex((l) => zone !== undefined && l.zoneIds.includes(zone.id));
      };
      for (const [x, y, ox, oy] of [
        [link.x0, link.y0, o.x0, o.y0],
        [link.x1, link.y1, o.x1, o.y1],
      ] as const) {
        const p = projectToClip(m[levelAtPoint(x, y)] as Float32Array, x, y);
        expect(ox, `link ${meta[i]?.id}`).toBeCloseTo(((p.x + 1) / 2) * canvas.width, 3);
        expect(oy, `link ${meta[i]?.id}`).toBeCloseTo(((1 - p.y) / 2) * canvas.height, 3);
      }
    });
  });

  it("fade with the pose and carry the colour alpha through", () => {
    const pose = { ...introPose(3200, 16 / 9), bridgesAlpha: 0.5 };
    const out = bridgesToScreen(parts.bridges, ctx, levels, matricesAt(3200), canvas, pose);
    parts.bridges.links.forEach((link, i) => {
      expect((out.links[i] as LineInstance).color[3]).toBeCloseTo(link.color[3] * 0.5, 9);
    });
  });
});
