import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { drawGround, type Frame, type Primitives } from "../../src/render/gl/primitives";
import { drawMap } from "../../src/render/layers/map";
import { drawParticles } from "../../src/render/layers/particles";
import { ALERT_COLORS, hueOf, NEUTRAL } from "../../src/render/palette";
import { ParticleRing } from "../../src/render/particleRing";
import {
  buildView,
  createViewContext,
  type PanelInstance,
  ZONE_PANEL,
  zoneStates,
} from "../../src/render/view";
import { networkIndex, warmWorld } from "../fixtures/attack";

const index = networkIndex();
const ctx = createViewContext(network, index, layout);
const warm = () => warmWorld(index);

/** The same world with one machine changed. */
function withNode(
  id: string,
  change: Partial<ReturnType<typeof warm>["nodes"][number]>,
  base = warm(),
) {
  if (!base.nodes.some((n) => n.id === id)) throw new Error(`no node ${id}`);
  return { ...base, nodes: base.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) };
}

const nodeIn = (zone: string, skip = 0): string => {
  const found = network.nodes.filter((n) => n.zone === zone)[skip];
  if (!found) throw new Error(`no node in ${zone}`);
  return found.id;
};

const panelOf = (panels: readonly PanelInstance[], zoneId: string): PanelInstance => {
  const at = layout.zones.findIndex((z) => z.id === zoneId);
  const panel = panels[at];
  if (!panel) throw new Error(`no panel for ${zoneId}`);
  return panel;
};

describe("zone panels", () => {
  it("gives one rounded panel per layout zone, in layout order, on the layout rectangle", () => {
    const { panels } = buildView(warm(), ctx);
    expect(panels).toHaveLength(layout.zones.length);
    layout.zones.forEach((z, i) => {
      const p = panels[i];
      expect(p, z.id).toMatchObject({ x: z.x, y: z.y, w: z.w, h: z.h, radius: 6, border: 1.4 });
    });
    expect(ZONE_PANEL.radius).toBe(6);
    expect(ZONE_PANEL.border).toBe(1.4);
  });

  it("styles a quiet zone as neutral glass: fill 0.085 to 0.035, edge 0.55 with 0.85 on top, no glow", () => {
    const { panels } = buildView(warm(), ctx);
    for (const p of panels) {
      expect(p.fill).toEqual(NEUTRAL.zoneFill);
      expect(p.edge).toEqual(NEUTRAL.zoneEdge);
      expect(p.fillTop).toBeCloseTo(0.085, 9);
      expect(p.fillBottom).toBeCloseTo(0.035, 9);
      expect(p.edgeSide).toBeCloseTo(0.55, 9);
      expect(p.edgeTop).toBeCloseTo(0.85, 9);
      expect(p.innerGlow).toBe(10);
      expect(p.innerGlowAlpha).toBeCloseTo(0.1, 9);
      expect(p.glow).toBe(0);
    }
  });

  it("draws no dashed zone box any more", () => {
    const view = buildView(warm(), ctx);
    expect("zones" in view).toBe(false);
    expect(view.ground).toBe(true);
  });

  it("tints a zone where the intruder holds a machine: magenta edge 0.85, fill +0.045, glow 7", () => {
    const mail = nodeIn("z-corp");
    const world = withNode(mail, { integrity: 1 });
    const states = zoneStates(world, ctx);
    expect(states.get("z-corp")).toBe("breached");
    expect(states.get("z-ctrl")).toBe("quiet");

    const { panels } = buildView(world, ctx);
    const tinted = panelOf(panels, "z-corp");
    expect(tinted.edge).toEqual(ALERT_COLORS.attacker);
    expect(tinted.edgeSide).toBeCloseTo(0.85, 9);
    expect(tinted.edgeTop).toBeCloseTo(0.85, 9);
    expect(tinted.fillTop).toBeCloseTo(0.085 + 0.045, 9);
    expect(tinted.fillBottom).toBeCloseTo(0.035 + 0.045, 9);
    expect(tinted.glow).toBe(7);
    // The fill now leans toward the tint colour: its green channel is below the neutral grey's.
    expect(tinted.fill[1]).toBeLessThan(NEUTRAL.zoneFill[1]);
    // Every other zone is exactly as quiet as before.
    const quiet = buildView(warm(), ctx).panels;
    layout.zones.forEach((z, i) => {
      if (z.id !== "z-corp") expect(panels[i], z.id).toEqual(quiet[i]);
    });
  });

  it("tints a zone with a machine that lost control in the impact violet", () => {
    const tms = nodeIn("z-ctrl");
    const world = withNode(tms, { cmdBlocked: true });
    expect(zoneStates(world, ctx).get("z-ctrl")).toBe("lost");
    const lost = panelOf(buildView(world, ctx).panels, "z-ctrl");
    expect(lost.edge).toEqual(ALERT_COLORS.impact);
    expect(lost.edgeSide).toBeCloseTo(0.85, 9);
    expect(lost.glow).toBe(7);
  });

  it("lets lost beat breached when both are true in the same zone", () => {
    const a = nodeIn("z-ctrl", 0);
    const b = nodeIn("z-ctrl", 1);
    const world = withNode(b, { integrity: 1 }, withNode(a, { cmdBlocked: true }));
    expect(zoneStates(world, ctx).get("z-ctrl")).toBe("lost");
    expect(panelOf(buildView(world, ctx).panels, "z-ctrl").edge).toEqual(ALERT_COLORS.impact);
  });

  it("is a function of the world only: prev, alpha and mode change nothing", () => {
    const prev = warm();
    const world = withNode(nodeIn("z-corp"), { integrity: 2 });
    const plain = buildView(world, ctx).panels;
    expect(buildView(world, ctx, { prev, alpha: 0.37 }).panels).toEqual(plain);
    expect(buildView(world, ctx, { prev, alpha: 0.9, mode: "operator" }).panels).toEqual(plain);
  });

  it("keeps the neutral panel colours hue-free", () => {
    for (const c of [NEUTRAL.zoneFill, NEUTRAL.zoneEdge, NEUTRAL.ground]) {
      expect(hueOf(c)).toBeNull();
    }
  });
});

describe("draw-call budget", () => {
  it("issues at most 14 scene draws for a view where every instance list is non-empty", () => {
    let draws = 0;
    const pass = () => ({
      buffer: (count: number) => new Float32Array(Math.max(1, count) * 32),
      draw: (_gl: unknown, _data: unknown, count: number) => {
        if (count > 0) draws++;
      },
    });
    const prims = {
      lines: pass(),
      discs: pass(),
      particles: pass(),
      panels: pass(),
      ground: {
        draw: () => {
          draws++;
        },
      },
    } as unknown as Primitives;
    // A fake context: every call is a no-op, every constant is undefined.
    const gl = new Proxy({}, { get: () => () => undefined }) as unknown as WebGL2RenderingContext;

    const base = buildView(warm(), ctx);
    const aLine = base.links[0];
    const aDisc = base.nodes[0];
    if (!aLine || !aDisc) throw new Error("the view has no link or node");
    const view = {
      ...base,
      alerts: [aLine],
      defenseArrows: [aLine],
      defenses: [aDisc],
      halos: [aDisc],
    };
    for (const list of [
      view.panels,
      view.links,
      view.track,
      view.routes,
      view.alerts,
      view.defenseArrows,
      view.trains,
      view.signals,
      view.halos,
      view.nodes,
      view.defenses,
    ]) {
      expect(list.length).toBeGreaterThan(0);
    }

    const frame: Frame = { view: [1, 1, 0, 0], pxPerUnit: 1, simTime: 0 };
    const ring = new ParticleRing();
    ring.push({
      x0: 0,
      y0: 0,
      x1: 10,
      y1: 10,
      start: 0,
      duration: 2,
      size: 3,
      loop: false,
      color: [1, 1, 1, 1],
    });

    drawGround(gl, prims, frame, { width: 100, height: 100, sheetWidth: 1600, sheetHeight: 900 });
    drawMap(gl, prims, view, frame);
    // The renderer's ambient traffic is one more instanced draw between the map and the packets.
    prims.particles.draw(gl, new Float32Array(12), 1, {});
    drawParticles(gl, prims, ring, frame);

    expect(draws).toBeGreaterThan(0);
    expect(draws).toBeLessThanOrEqual(14);
  });
});
