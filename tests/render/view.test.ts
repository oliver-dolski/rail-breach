import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { stateHash } from "../../src/core/hash";
import { step } from "../../src/core/sim/step";
import { fitMap, pointAt, polyline, viewUniform } from "../../src/render/geometry";
import { SHAPE, SIGNAL_COLORS } from "../../src/render/palette";
import { buildView, createViewContext, nodeVisualState } from "../../src/render/view";
import { networkIndex, run, scenario, warmWorld } from "../fixtures/attack";

const index = networkIndex();
const ctx = createViewContext(network, index, layout);
const warm = () => warmWorld(index);

describe("buildView", () => {
  it("is a pure function of the snapshot: two calls give deeply equal views and leave the world alone", () => {
    const world = warm();
    const before = stateHash(world);
    const a = buildView(world, ctx);
    const b = buildView(world, ctx);
    expect(b).toEqual(a);
    expect(stateHash(world)).toBe(before);
  });

  it("stays idempotent with interpolation, and a re-run after a context restore equals the first run", () => {
    const prev = warm();
    const world = step(prev, [], index).world;
    const first = buildView(world, ctx, { prev, alpha: 0.4 });
    const second = buildView(world, ctx, { prev, alpha: 0.4 });
    expect(second).toEqual(first);
    expect(stateHash(world)).toBe(stateHash(step(prev, [], index).world));
  });

  it("maps the fictional content into the expected number of instances", () => {
    const world = warm();
    const view = buildView(world, ctx);

    expect(view.signals).toHaveLength(index.rail.graph.signals.length);
    expect(view.signals).toHaveLength(19);
    expect(view.nodes).toHaveLength(network.nodes.length);
    expect(view.links).toHaveLength(network.links.length);
    expect(view.trains).toHaveLength(world.trains.length);
    expect(world.trains.length).toBeGreaterThan(0);

    // One polyline per track section, one segment per polyline leg, plus the connectors.
    const sections = new Set<number>();
    let segments = 0;
    for (const block of network.tracks.blocks) {
      const section = index.rail.graph.blockSection.get(block.id) ?? -1;
      if (sections.has(section)) continue;
      sections.add(section);
      segments += (layout.blocks[block.id]?.length ?? 1) - 1;
    }
    for (const c of layout.connectors) segments += c.length - 1;
    expect(view.track).toHaveLength(segments);
    expect(view.stats.trains).toBe(world.trains.length);
    expect(view.stats.signals).toBe(19);
  });

  it("draws a train as a capsule that is long enough to read, inside the sheet", () => {
    const view = buildView(warm(), ctx);
    for (const t of view.trains) {
      expect(Math.hypot(t.x1 - t.x0, t.y1 - t.y0)).toBeGreaterThanOrEqual(15.9);
      for (const v of [t.x0, t.x1]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of [t.y0, t.y1]) expect(v).toBeGreaterThanOrEqual(0);
      expect(Math.max(t.x0, t.x1)).toBeLessThanOrEqual(layout.width);
      expect(Math.max(t.y0, t.y1)).toBeLessThanOrEqual(layout.height);
    }
  });

  it("moves a train from the previous snapshot to the current one as alpha grows", () => {
    const prev = warm();
    const world = step(prev, [], index).world;
    const current = buildView(world, ctx).trains;
    expect(buildView(world, ctx, { prev, alpha: 1 }).trains).toEqual(current);
    const start = buildView(world, ctx, { prev, alpha: 0 }).trains;
    const mid = buildView(world, ctx, { prev, alpha: 0.5 }).trains;
    const i = world.trains.findIndex((t) => t.speedDmPerTick > 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const x = (v: typeof current) => v[i]?.x1 ?? Number.NaN;
    const y = (v: typeof current) => v[i]?.y1 ?? Number.NaN;
    const d = (v: typeof current) => Math.hypot(x(v) - x(start), y(v) - y(start));
    expect(d(current)).toBeGreaterThan(0);
    expect(d(mid)).toBeGreaterThan(0);
    expect(d(mid)).toBeLessThan(d(current));
  });

  it("shows every signal with the aspect the core derives, in the signal palette", () => {
    const view = buildView(warm(), ctx);
    const colors = [SIGNAL_COLORS.stop, SIGNAL_COLORS.caution, SIGNAL_COLORS.proceed].map((c) =>
      c.map((v) => v.toFixed(3)).join(","),
    );
    let lit = 0;
    for (const s of view.signals) {
      if (s.shape !== SHAPE.lamp) continue;
      lit++;
      expect(colors).toContain(
        s.color
          .slice(0, 3)
          .map((v) => v.toFixed(3))
          .join(","),
      );
    }
    expect(lit).toBeGreaterThan(0);
    expect(view.stats.signalsAtStop).toBeGreaterThan(0);
  });

  it("changes a lost machine's glyph, not only its colour", () => {
    const base = warm();
    const tms = base.nodes.findIndex((n) => n.id === "tms-server");
    const hit = {
      ...base,
      nodes: base.nodes.map((n, i) => (i === tms ? { ...n, cmdBlocked: true } : n)),
    };
    const before = buildView(base, ctx).nodes[tms];
    const after = buildView(hit, ctx).nodes[tms];
    expect(after?.shape).not.toBe(before?.shape);
    expect(after?.color).not.toEqual(before?.color);
    expect(buildView(hit, ctx).stats.nodesLost).toBe(1);
  });

  it("pulses a ring around a machine a technique is working on", () => {
    const attacked = run(warm(), index, scenario.actions, (scenario.actions[0]?.t ?? 0) + 30);
    expect(attacked.world.ops.length).toBeGreaterThan(0);
    const plain = buildView(warm(), ctx).halos.length;
    expect(buildView(attacked.world, ctx).halos.length).toBeGreaterThan(plain);
  });
});

describe("nodeVisualState", () => {
  const node = warm().nodes[0];
  if (!node) throw new Error("no nodes");
  it("ranks lost above compromised above degraded above normal", () => {
    expect(nodeVisualState(node)).toBe("normal");
    expect(nodeVisualState({ ...node, view: "frozen" })).toBe("degraded");
    expect(nodeVisualState({ ...node, availability: "degraded" })).toBe("degraded");
    expect(nodeVisualState({ ...node, integrity: 1 })).toBe("compromised");
    expect(nodeVisualState({ ...node, integrity: 1, cmdBlocked: true })).toBe("lost");
    expect(nodeVisualState({ ...node, controlDenied: true })).toBe("lost");
    expect(nodeVisualState({ ...node, availability: "down" })).toBe("lost");
  });
});

describe("layout", () => {
  it("places every machine, every block and every zone of the content", () => {
    for (const n of network.nodes) expect(layout.nodes[n.id], n.id).toBeDefined();
    for (const b of network.tracks.blocks) {
      expect(layout.blocks[b.id]?.length ?? 0, b.id).toBeGreaterThanOrEqual(2);
    }
    for (const z of network.zones) {
      expect(
        layout.zones.some((box) => box.id === z.id),
        z.id,
      ).toBe(true);
    }
  });

  it("keeps everything inside the sheet", () => {
    const inside = (x: number, y: number) =>
      x >= 0 && x <= layout.width && y >= 0 && y <= layout.height;
    for (const n of Object.values(layout.nodes)) expect(inside(n.x, n.y)).toBe(true);
    for (const pts of Object.values(layout.blocks)) {
      for (const p of pts) expect(inside(p.x, p.y)).toBe(true);
    }
    for (const z of layout.zones) {
      expect(inside(z.x, z.y) && inside(z.x + z.w, z.y + z.h)).toBe(true);
    }
  });

  it("is presentation only: nothing under src/core imports it", () => {
    const offenders = sourceFiles("src/core").filter((f) =>
      /from\s+["'][^"']*(content\/layout|\/render\/|\/ui\/|\/app\/)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("geometry", () => {
  it("finds points along a polyline by fraction of its length", () => {
    const line = polyline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(line.length).toBe(20);
    expect(pointAt(line, 0)).toMatchObject({ x: 0, y: 0 });
    expect(pointAt(line, 0.5)).toMatchObject({ x: 10, y: 0 });
    expect(pointAt(line, 0.75)).toMatchObject({ x: 10, y: 5 });
    expect(pointAt(line, 2)).toMatchObject({ x: 10, y: 10 });
  });

  it("fits the sheet into any canvas without distortion, and maps its centre to the clip centre", () => {
    for (const [w, h] of [
      [1600, 900],
      [1260, 900],
      [3200, 1800],
      [800, 1200],
    ] as const) {
      const fit = fitMap(w, h, 1600, 900);
      const [sx, sy, ox, oy] = viewUniform(fit, w, h);
      const clipX = 800 * sx + ox;
      const clipY = 450 * sy + oy;
      expect(clipX).toBeCloseTo(0, 6);
      expect(clipY).toBeCloseTo(0, 6);
      // Equal scale on both axes: a square on the sheet stays square on screen.
      expect(Math.abs(sx * w)).toBeCloseTo(Math.abs(sy * h), 6);
    }
  });
});

describe("what the renderer may use", () => {
  const files = [...sourceFiles("src/render"), ...sourceFiles("src/ui"), ...sourceFiles("src/app")];

  it("never asks for gl.lineWidth or gl.POINTS (thick lines are instanced quads)", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8")
        .split("\n")
        .filter(
          (l) =>
            !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"),
        )
        .join("\n");
      expect(text, f).not.toMatch(/\blineWidth\s*\(/);
      expect(text, f).not.toMatch(/\.POINTS\b/);
    }
  });

  it("never writes markup: no innerHTML, outerHTML or insertAdjacentHTML", () => {
    for (const f of files) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /\b(innerHTML|outerHTML|insertAdjacentHTML)\b\s*[=(]/,
      );
    }
  });

  it("keeps twgl inside src/render", () => {
    for (const f of [
      ...sourceFiles("src/ui"),
      ...sourceFiles("src/app"),
      ...sourceFiles("src/core"),
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from\s+["']twgl\.js["']/);
    }
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|glsl)$/.test(name)) out.push(path);
  }
  return out;
}
