import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import type { Content } from "../../src/content/types";
import type { TimedAction } from "../../src/core/replay/recording";
import type { Action } from "../../src/core/sim/actions";
import { DEFENSE_PLACEMENT_LATENCY_TICKS } from "../../src/core/sim/constants";
import { createWorld } from "../../src/core/sim/world";
import { fitMap, screenToMap } from "../../src/render/geometry";
import {
  ALERT_HUES,
  DEFENSE_COLORS,
  DEFENSE_HUES,
  hueDistance,
  hueOf,
  SHAPE,
  SIGNAL_HUES,
} from "../../src/render/palette";
import { buildView, createViewContext, nearestConduit } from "../../src/render/view";
import { placedRows, placementFor } from "../../src/ui/panel/defense";
import { networkIndex, run } from "../fixtures/attack";

const index = networkIndex();
const ctx = createViewContext(network, index, layout);
/** The palette test's threshold between a signal hue and anything else. */
const MIN_GAP_DEG = 40;
const CONDUIT = "c-dmz-ctrl";

const place = (t: number, action: Action): TimedAction => ({ t, a: action });
const members = network.links.filter((l) => l.conduit === CONDUIT);

const midpoint = (linkId: string) => {
  const link = network.links.find((l) => l.id === linkId);
  const a = layout.nodes[link?.a ?? ""];
  const b = layout.nodes[link?.b ?? ""];
  if (!a || !b) throw new Error(`no layout for ${linkId}`);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

const worldWith = (actions: TimedAction[], toTick: number) =>
  run(createWorld(network, 1), index, actions, toTick).world;

describe("a placed defense on the map", () => {
  const firewall: Action = { type: "defense.place", kind: "firewall", on: { conduit: CONDUIT } };

  it("is one glyph per guarded link, on that link, and nothing when nothing is placed", () => {
    expect(buildView(createWorld(network, 1), ctx).defenses).toEqual([]);
    expect(buildView(createWorld(network, 1), ctx).defenseArrows).toEqual([]);

    const view = buildView(worldWith([place(1, firewall)], 2), ctx);
    expect(view.defenses).toHaveLength(members.length);
    const spots = members.map((l) => midpoint(l.id));
    for (const glyph of view.defenses) {
      expect(spots).toContainEqual({ x: glyph.x, y: glyph.y });
      expect(glyph.shape).toBe(SHAPE.disc);
    }
  });

  it("is faint until it is in force, then at full strength with a glow", () => {
    const pending = buildView(worldWith([place(1, firewall)], 2), ctx).defenses[0];
    const inForce = buildView(
      worldWith([place(1, firewall)], 2 + DEFENSE_PLACEMENT_LATENCY_TICKS),
      ctx,
    ).defenses[0];
    expect(pending?.color[3]).toBeLessThan(0.5);
    expect(pending?.glow).toBe(0);
    expect(inForce?.color[3]).toBe(1);
    expect(inForce?.glow).toBeGreaterThan(0);
  });

  it("is drawn in a hue at least the palette gap away from every signal hue", () => {
    const world = worldWith(
      [
        place(1, firewall),
        place(2, {
          type: "defense.place",
          kind: "diode",
          on: { conduit: "c-corp-dmz" },
          config: { direction: "b-to-a" },
        }),
        place(3, { type: "defense.place", kind: "ids", on: { conduit: "c-net-corp" } }),
      ],
      3 + DEFENSE_PLACEMENT_LATENCY_TICKS,
    );
    const view = buildView(world, ctx);
    expect(view.defenses.length).toBeGreaterThan(3);
    for (const glyph of [...view.defenses, ...view.defenseArrows]) {
      const hue = hueOf([glyph.color[0], glyph.color[1], glyph.color[2]]);
      expect(hue).not.toBeNull();
      for (const signal of Object.values(SIGNAL_HUES)) {
        expect(hueDistance(hue ?? 0, signal)).toBeGreaterThanOrEqual(MIN_GAP_DEG - 8);
      }
    }
  });

  it("tells a firewall, a diode and an IDS sensor apart by shape as well as colour", () => {
    const world = worldWith(
      [
        place(1, { type: "defense.place", kind: "firewall", on: { link: "l-dmz-hmi1" } }),
        place(1, { type: "defense.place", kind: "diode", on: { link: "l-dmz-hist" } }),
        place(1, { type: "defense.place", kind: "ids", on: { link: "l-jump-eng" } }),
      ],
      2,
    );
    const shapes = buildView(world, ctx).defenses.map((g) => g.shape);
    expect(new Set(shapes).size).toBe(3);
    expect(shapes).toEqual([SHAPE.disc, SHAPE.triangle, SHAPE.ring]);
  });

  it("shows a diode's direction with an arrow along the link, pointing the way data may pass", () => {
    const linkId = "l-dmz-hist";
    const link = network.links.find((l) => l.id === linkId);
    const a = layout.nodes[link?.a ?? ""];
    const b = layout.nodes[link?.b ?? ""];
    if (!a || !b) throw new Error("no layout");
    const along = { x: b.x - a.x, y: b.y - a.y };

    const arrowFor = (direction: "a-to-b" | "b-to-a") => {
      const world = worldWith(
        [
          place(1, {
            type: "defense.place",
            kind: "diode",
            on: { link: linkId },
            config: { direction },
          }),
        ],
        2,
      );
      const arrows = buildView(world, ctx).defenseArrows;
      expect(arrows).toHaveLength(3);
      const [shaft] = arrows;
      if (!shaft) throw new Error("no shaft");
      return { x: shaft.x1 - shaft.x0, y: shaft.y1 - shaft.y0 };
    };
    const forward = arrowFor("a-to-b");
    const backward = arrowFor("b-to-a");
    expect(forward.x * along.x + forward.y * along.y).toBeGreaterThan(0);
    expect(backward.x * along.x + backward.y * along.y).toBeLessThan(0);
  });

  it("does not change the view of anything else: the same world with and without is otherwise equal", () => {
    const plain = buildView(createWorld(network, 1), ctx);
    const guarded = buildView(worldWith([place(1, firewall)], 1), ctx);
    const { defenses, defenseArrows, tick, phase, ...rest } = guarded;
    const { defenses: d0, defenseArrows: a0, tick: t0, phase: p0, ...rest0 } = plain;
    expect(rest).toEqual(rest0);
    expect([defenses.length > 0, defenseArrows, a0, d0, tick, phase]).toEqual([
      true,
      [],
      [],
      [],
      1,
      1,
    ]);
    expect([t0, p0]).toEqual([0, 0]);
  });
});

describe("the defense colours", () => {
  it("keep a hue of their own, clear of the signals and of every alert hue", () => {
    for (const signal of Object.values(SIGNAL_HUES)) {
      expect(hueDistance(DEFENSE_HUES.barrier, signal)).toBeGreaterThanOrEqual(MIN_GAP_DEG);
    }
    for (const alert of Object.values(ALERT_HUES)) {
      expect(hueDistance(DEFENSE_HUES.barrier, alert)).toBeGreaterThanOrEqual(30);
    }
  });

  it("hold for the colour itself, measured from its RGB", () => {
    const measured = hueOf(DEFENSE_COLORS.barrier);
    expect(hueDistance(measured ?? 0, DEFENSE_HUES.barrier)).toBeLessThan(8);
    for (const signal of Object.values(SIGNAL_HUES)) {
      expect(hueDistance(measured ?? 0, signal)).toBeGreaterThanOrEqual(MIN_GAP_DEG - 8);
    }
  });
});

describe("zones and conduits on the map", () => {
  it("every zone has a box and a label", () => {
    expect(layout.zones.map((z) => z.id).sort()).toEqual(network.zones.map((z) => z.id).sort());
    for (const zone of layout.zones) expect(zone.label).not.toBe("");
  });

  it("every conduit has a caption and a spot where its links run, and no caption is for nothing", () => {
    expect(Object.keys(layout.conduits).sort()).toEqual(network.conduits.map((c) => c.id).sort());
    expect(ctx.conduitMarks.map((m) => m.id).sort()).toEqual(
      network.conduits.map((c) => c.id).sort(),
    );
    for (const mark of ctx.conduitMarks) {
      expect(mark.label).toBe(layout.conduits[mark.id]);
      expect(Number.isFinite(mark.x) && Number.isFinite(mark.y)).toBe(true);
    }
  });
});

describe("picking a conduit on the map", () => {
  it("finds the conduit whose link is under the point", () => {
    expect(nearestConduit(ctx, midpoint("l-dmz-hmi1"), 10)).toBe("c-dmz-ctrl");
    expect(nearestConduit(ctx, midpoint("l-net-mail"), 10)).toBe("c-net-corp");
    expect(nearestConduit(ctx, midpoint("l-il-oc-vel"), 10)).toBe("c-vel-way");
  });

  it("finds nothing away from every conduit, and never picks a link inside a zone", () => {
    expect(nearestConduit(ctx, { x: 1590, y: 10 }, 12)).toBeUndefined();
    // l-mail-office runs inside the corporate zone and belongs to no conduit.
    expect(nearestConduit(ctx, midpoint("l-mail-office"), 4)).toBeUndefined();
  });

  it("is exact at the edge: a point within the radius hits, one beyond misses", () => {
    const at = midpoint("l-dmz-hmi1");
    expect(nearestConduit(ctx, { x: at.x, y: at.y }, 0.001)).toBe("c-dmz-ctrl");
    const link = network.links.find((l) => l.id === "l-dmz-hmi1");
    const a = layout.nodes[link?.a ?? ""];
    const b = layout.nodes[link?.b ?? ""];
    if (!a || !b) throw new Error("no layout");
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const normal = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const off = (d: number) => ({ x: at.x + normal.x * d, y: at.y + normal.y * d });
    expect(nearestConduit(ctx, off(5), 6)).toBe("c-dmz-ctrl");
    expect(nearestConduit(ctx, off(7), 6)).not.toBe("c-dmz-ctrl");
  });
});

describe("a click on the canvas", () => {
  it("lands on the map point a label would be drawn at, at any pixel ratio", () => {
    for (const dpr of [1, 1.5, 2]) {
      const fit = fitMap(1234 * dpr, 777 * dpr, layout.width, layout.height);
      const node = layout.nodes["dmz-relay"];
      if (!node) throw new Error("no layout");
      // Where a label for this node is placed, in CSS pixels (see createLabels).
      const cssX = (fit.ox + node.x * fit.scale) / dpr;
      const cssY = (fit.oy + node.y * fit.scale) / dpr;
      const back = screenToMap(fit, dpr, cssX, cssY);
      expect(back.x).toBeCloseTo(node.x, 6);
      expect(back.y).toBeCloseTo(node.y, 6);
    }
  });

  it("picks the conduit under a click drawn at a link's middle", () => {
    const dpr = 2;
    const fit = fitMap(1600 * dpr, 900 * dpr, layout.width, layout.height);
    const mid = midpoint("l-dmz-hmi1");
    const at = screenToMap(
      fit,
      dpr,
      (fit.ox + mid.x * fit.scale) / dpr,
      (fit.oy + mid.y * fit.scale) / dpr,
    );
    expect(nearestConduit(ctx, at, (14 * dpr) / fit.scale)).toBe("c-dmz-ctrl");
  });
});

describe("the defense palette's pure parts", () => {
  it("builds a firewall and an IDS placement on the named conduit", () => {
    expect(placementFor({ kind: "firewall", flow: "office" }, CONDUIT, network)).toEqual({
      type: "defense.place",
      kind: "firewall",
      on: { conduit: CONDUIT },
    });
    expect(placementFor({ kind: "ids", flow: "office" }, CONDUIT, network)).toEqual({
      type: "defense.place",
      kind: "ids",
      on: { conduit: CONDUIT },
    });
  });

  it("reads a diode's flow off the two zones, whichever way the conduit is written", () => {
    // DMZ (3.5) is written first, control centre (3) second: data to the office runs B to A.
    expect(placementFor({ kind: "diode", flow: "office" }, CONDUIT, network)).toMatchObject({
      config: { direction: "b-to-a" },
    });
    expect(placementFor({ kind: "diode", flow: "tracks" }, CONDUIT, network)).toMatchObject({
      config: { direction: "a-to-b" },
    });
    const swapped: Content = {
      ...network,
      conduits: network.conduits.map((c) =>
        c.id === CONDUIT ? { ...c, zoneA: c.zoneB, zoneB: c.zoneA } : c,
      ),
    };
    expect(placementFor({ kind: "diode", flow: "office" }, CONDUIT, swapped)).toMatchObject({
      config: { direction: "a-to-b" },
    });
  });

  it("builds nothing for a conduit the content does not have", () => {
    expect(
      placementFor({ kind: "firewall", flow: "office" }, "c-nowhere", network),
    ).toBeUndefined();
  });

  it("the placements it builds are accepted by the engine and do what the label says", () => {
    const action = placementFor({ kind: "diode", flow: "office" }, CONDUIT, network);
    if (action === undefined) throw new Error("no action");
    const world = worldWith([place(1, action)], 1 + DEFENSE_PLACEMENT_LATENCY_TICKS);
    const hmi = world.defenses.find((d) => d.link === "l-dmz-hmi1");
    // Office is the DMZ side: the link's first end is the DMZ relay, so it lets b-to-a pass.
    expect(hmi?.direction).toBe("b-to-a");
  });

  it("words each placement once, however many links it made, with its state", () => {
    const fw: Action = { type: "defense.place", kind: "firewall", on: { conduit: CONDUIT } };
    const pending = placedRows(worldWith([place(1, fw)], 2), network);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("d1");
    expect(pending[0]?.text).toContain("Firewall on DMZ to control centre");
    expect(pending[0]?.text).toContain("blocks everything");
    expect(pending[0]?.text).toMatch(/in force in \d+ s$/);

    const live = placedRows(
      worldWith([place(1, fw)], 2 + DEFENSE_PLACEMENT_LATENCY_TICKS),
      network,
    );
    expect(live[0]?.text).toMatch(/in force$/);
  });

  it("says which zone a diode lets data go from and to", () => {
    const action = placementFor({ kind: "diode", flow: "office" }, CONDUIT, network);
    if (action === undefined) throw new Error("no action");
    const rows = placedRows(worldWith([place(1, action)], 2), network);
    expect(rows[0]?.text).toContain("data Control centre to DMZ");
  });
});
