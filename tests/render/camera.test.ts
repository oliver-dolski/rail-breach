import { describe, expect, it } from "vitest";
import { createManualFrames } from "../../src/app/capture";
import { catalog } from "../../src/app/catalog";
import { startLoop } from "../../src/app/loop";
import { createAttractSession } from "../../src/app/session";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import {
  CAMERA_EASE,
  CAMERA_OFF_EASE,
  type CameraPose,
  type CameraState,
  CameraTrack,
  cameraFit,
  cameraSignals,
  FOCUS_HOLD_TICKS,
  FOCUS_ZOOM,
  focusPose,
  focusZoneOf,
  homeCamera,
  lerpPose,
  MAX_ZOOM,
  MIN_ZOOM,
  stepCamera,
} from "../../src/render/camera";
import { fitMap, screenToMap } from "../../src/render/geometry";
import { placeLabels } from "../../src/render/labelgeometry";
import { createViewContext, nearestConduit } from "../../src/render/view";
import { networkIndex, warmWorld } from "../fixtures/attack";

const index = networkIndex();
const ctx = createViewContext(network, index, layout);
const zoneOfNode = ctx.nodeZone;

const canvases: [number, number][] = [
  [1192, 860],
  [1280, 720],
  [820, 461.25],
  [1920, 1080],
  [1600, 900],
];

const homeOf = (w: number, h: number) => fitMap(w, h, layout.width, layout.height);

describe("the camera transform", () => {
  it("is the home fit exactly at the home pose", () => {
    for (const [w, h] of canvases) {
      const home = homeOf(w, h);
      expect(cameraFit(home, homeCamera(layout), layout)).toEqual(home);
    }
  });

  it("puts the pose centre in the middle of the canvas and scales by the zoom", () => {
    const [w, h] = [1192, 860];
    const home = homeOf(w, h);
    const pose: CameraPose = { zoom: 1.25, cx: 520, cy: 310 };
    const fit = cameraFit(home, pose, layout);
    expect(fit.scale).toBeCloseTo(home.scale * 1.25, 9);
    expect(fit.ox + pose.cx * fit.scale).toBeCloseTo(w / 2, 6);
    expect(fit.oy + pose.cy * fit.scale).toBeCloseTo(h / 2, 6);
  });

  it("is a pure scale of positions: canvas centre + zoom * (home projection - home projection of the centre)", () => {
    for (const [w, h] of canvases) {
      const home = homeOf(w, h);
      for (const zone of layout.zones) {
        const pose = focusPose(zone.id, layout);
        const fit = cameraFit(home, pose, layout);
        const proj = (p: { x: number; y: number }) => ({
          x: home.ox + p.x * home.scale,
          y: home.oy + p.y * home.scale,
        });
        const c = proj({ x: pose.cx, y: pose.cy });
        for (const n of Object.values(layout.nodes)) {
          const p = proj(n);
          expect(fit.ox + n.x * fit.scale).toBeCloseTo(w / 2 + pose.zoom * (p.x - c.x), 6);
          expect(fit.oy + n.y * fit.scale).toBeCloseTo(h / 2 + pose.zoom * (p.y - c.y), 6);
        }
      }
    }
  });

  it("round trips every conduit caption through the pixel and back at every focus pose, and the pick finds the conduit", () => {
    expect(ctx.conduitMarks.length).toBeGreaterThan(0);
    for (const [w, h] of canvases) {
      const home = homeOf(w, h);
      for (const dpr of [1, 1.5]) {
        const poses = [homeCamera(layout), ...layout.zones.map((z) => focusPose(z.id, layout))];
        for (const pose of poses) {
          const fit = cameraFit(home, pose, layout);
          for (const mark of ctx.conduitMarks) {
            const cssX = (fit.ox + mark.x * fit.scale) / dpr;
            const cssY = (fit.oy + mark.y * fit.scale) / dpr;
            const back = screenToMap(fit, dpr, cssX, cssY);
            expect(back.x).toBeCloseTo(mark.x, 6);
            expect(back.y).toBeCloseTo(mark.y, 6);
            expect(nearestConduit(ctx, back, (14 * dpr) / fit.scale), mark.id).toBe(mark.id);
          }
        }
      }
    }
  });
});

describe("the focus pose", () => {
  it("is zoom 1.3 with a visible window that stays inside the sheet, for every zone", () => {
    expect(FOCUS_ZOOM).toBe(1.3);
    expect(MIN_ZOOM).toBe(1);
    expect(MAX_ZOOM).toBe(1.3);
    for (const zone of layout.zones) {
      const pose = focusPose(zone.id, layout);
      expect(pose.zoom).toBe(1.3);
      const halfW = layout.width / pose.zoom / 2;
      const halfH = layout.height / pose.zoom / 2;
      expect(pose.cx - halfW).toBeGreaterThanOrEqual(-1e-9);
      expect(pose.cx + halfW).toBeLessThanOrEqual(layout.width + 1e-9);
      expect(pose.cy - halfH).toBeGreaterThanOrEqual(-1e-9);
      expect(pose.cy + halfH).toBeLessThanOrEqual(layout.height + 1e-9);
    }
  });

  it("leans 0.6 of the way from the sheet centre toward the zone centre where the clamp allows", () => {
    const zone = layout.zones.find((z) => z.id === "z-corp");
    if (!zone) throw new Error("no z-corp");
    const pose = focusPose("z-corp", layout);
    const zx = zone.x + zone.w / 2;
    const zy = zone.y + zone.h / 2;
    const wantX = layout.width / 2 + (zx - layout.width / 2) * 0.6;
    const halfW = layout.width / 1.3 / 2;
    expect(pose.cx).toBeCloseTo(Math.min(Math.max(wantX, halfW), layout.width - halfW), 9);
    expect(zy).toBeGreaterThan(0);
  });

  it("falls back to home for a zone the layout does not have", () => {
    expect(focusPose("z-nowhere", layout)).toEqual({
      zoom: 1,
      cx: layout.width / 2,
      cy: layout.height / 2,
    });
  });
});

describe("what the camera reads from the world", () => {
  it("picks the zone of the newest running operation, at its path node until it arrives and at its target after", () => {
    const base = warmWorld(index);
    expect(focusZoneOf({ ...base, ops: [] }, zoneOfNode)).toBeUndefined();
    const op = (id: number, hop: number) => ({
      id,
      technique: "T0865" as const,
      target: "corp-ws-dispatch",
      path: ["internet", "corp-mail", "corp-ws-dispatch"],
      links: ["l-net-mail", "l-mail-dispatch"],
      hop,
      doneAt: 0,
    });
    expect(focusZoneOf({ ...base, ops: [op(1, 0)] }, zoneOfNode)).toBe("z-internet");
    expect(focusZoneOf({ ...base, ops: [op(1, 1)] }, zoneOfNode)).toBe("z-corp");
    const newest = { ...op(2, 2), target: "dmz-relay", path: ["corp-ws-dispatch", "dmz-relay"] };
    expect(focusZoneOf({ ...base, ops: [op(1, 0), { ...newest, hop: 1 }] }, zoneOfNode)).toBe(
      "z-dmz",
    );
    expect(focusZoneOf({ ...base, ops: [{ ...newest, hop: 1 }, op(1, 0)] }, zoneOfNode)).toBe(
      "z-dmz",
    );
  });

  it("counts standing trains and machines that lost control", () => {
    const base = warmWorld(index);
    const signals = cameraSignals(base);
    expect(signals.trainsStanding).toBe(base.trains.filter((t) => t.speedDmPerTick === 0).length);
    expect(signals.nodesLost).toBe(0);
    const tms = base.nodes.find((n) => n.id === "tms-server");
    if (!tms) throw new Error("no tms-server");
    const lost = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === "tms-server" ? { ...n, cmdBlocked: true } : n)),
    };
    expect(cameraSignals(lost).nodesLost).toBe(1);
  });
});

describe("lerpPose", () => {
  it("interpolates zoom and centre, and returns the ends at 0 and 1", () => {
    const a: CameraPose = { zoom: 1, cx: 800, cy: 450 };
    const b: CameraPose = { zoom: 1.3, cx: 600, cy: 300 };
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
    const mid = lerpPose(a, b, 0.5);
    expect(mid.zoom).toBeCloseTo(1.15, 12);
    expect(mid.cx).toBeCloseTo(700, 12);
    expect(mid.cy).toBeCloseTo(375, 12);
  });
});

interface Sample {
  elapsed: number;
  state: CameraState;
}

/** Plays a scenario one tick at a time and steps a camera after every tick, the way the page does. */
function playFresh(
  scenarioIndex: number,
  ticks: number,
  options: { enabled?: boolean; reducedMotion?: boolean } = {},
): Sample[] {
  const entry = catalog[scenarioIndex];
  if (!entry) throw new Error("no scenario");
  const session = createAttractSession({ scenario: entry.scenario, recording: entry.recording });
  const zones = createViewContext(network, session.index, layout).nodeZone;
  let state = homeCamera(layout);
  const out: Sample[] = [];
  for (let i = 0; i < ticks; i++) {
    session.advance(1);
    state = stepCamera(state, {
      world: session.world(),
      zoneOfNode: zones,
      layout,
      enabled: options.enabled ?? true,
      reducedMotion: options.reducedMotion ?? false,
    });
    out.push({ elapsed: session.elapsedTicks(), state });
  }
  return out;
}

const played = new Map<string, Sample[]>();
/** The same, remembered: replaying a show costs a second, and several cases read the same one. */
function playCamera(
  scenarioIndex: number,
  ticks: number,
  options: { enabled?: boolean; reducedMotion?: boolean } = {},
): Sample[] {
  const key = JSON.stringify([scenarioIndex, ticks, options]);
  const known = played.get(key);
  if (known) return known;
  const run = playFresh(scenarioIndex, ticks, options);
  played.set(key, run);
  return run;
}

const away = (s: CameraState): boolean => s.zoom > 1.01;
const isHome = (s: CameraPose): boolean =>
  Math.abs(s.zoom - 1) < 1e-3 &&
  Math.abs(s.cx - layout.width / 2) < 0.5 &&
  Math.abs(s.cy - layout.height / 2) < 0.5;

describe("stepCamera", { timeout: 60000 }, () => {
  it("is a pure function of the tick sequence: two runs agree at every tick (G9)", () => {
    const a = playFresh(0, 400);
    const b = playFresh(0, 400);
    expect(b).toEqual(a);
  });

  it("does not change its input state or the world", () => {
    const world = warmWorld(index);
    const before = JSON.stringify(world);
    const state = homeCamera(layout);
    const copy = JSON.stringify(state);
    stepCamera(state, { world, zoneOfNode, layout, enabled: true, reducedMotion: false });
    expect(JSON.stringify(world)).toBe(before);
    expect(JSON.stringify(state)).toBe(copy);
  });

  it("gives the same camera state at the same session tick whatever the frame length (40 ms and 16 ms)", () => {
    const run = (frameMs: number): Map<number, CameraState> => {
      const entry = catalog[0];
      if (!entry) throw new Error("no scenario");
      const session = createAttractSession({
        scenario: entry.scenario,
        recording: entry.recording,
      });
      const track = new CameraTrack(layout);
      const seen = new Map<number, CameraState>();
      const target = {
        advance(ticks: number): void {
          for (let i = 0; i < ticks; i++) {
            const before = session.world();
            session.advance(1);
            if (session.world() === before) return;
            track.step({
              world: session.world(),
              zoneOfNode,
              enabled: true,
              reducedMotion: false,
            });
            seen.set(session.elapsedTicks(), track.current());
          }
        },
      };
      const manual = createManualFrames(frameMs);
      startLoop(target, () => undefined, { deps: manual.deps });
      let guard = 0;
      while (session.elapsedTicks() < 300 && guard++ < 100000) manual.frame();
      return seen;
    };
    const coarse = run(40);
    const fine = run(16);
    let compared = 0;
    for (const [tick, state] of coarse) {
      const other = fine.get(tick);
      if (other === undefined || tick > 300) continue;
      expect(other, `tick ${tick}`).toEqual(state);
      compared++;
    }
    expect(compared).toBeGreaterThan(250);
  });

  it("follows the phishing attack and is home again at 00:34", () => {
    const run = playCamera(0, 400);
    const leaves = run.find((s) => s.elapsed >= 10 && s.elapsed <= 180 && away(s.state));
    expect(leaves).toBeDefined();
    const at340 = run.find((s) => s.elapsed === 340);
    expect(at340).toBeDefined();
    expect(isHome(at340?.state ?? run[0]?.state ?? homeCamera(layout))).toBe(true);
    for (const s of run) {
      expect(s.state.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(s.state.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    }
  });

  it("latches home for the rest of the show once a machine is lost and more trains stand than at the start", () => {
    const run = playCamera(0, 700);
    const latched = run.find((s) => s.state.latched);
    expect(latched).toBeDefined();
    const from = latched?.elapsed ?? 0;
    expect(from).toBeGreaterThan(0);
    for (const s of run.filter((x) => x.elapsed >= from)) expect(s.state.latched).toBe(true);
    // Once latched the pose only moves toward home.
    const after = run.filter((x) => x.elapsed >= from);
    for (let i = 1; i < after.length; i++) {
      expect(after[i]?.state.zoom ?? 9).toBeLessThanOrEqual(
        (after[i - 1]?.state.zoom ?? 0) + 1e-12,
      );
    }
  });

  it("leaves home at least once in the vendor VPN and insider shows", () => {
    for (const which of [1, 2]) {
      const run = playCamera(which, 400);
      expect(
        run.some((s) => away(s.state)),
        `scenario ${which}`,
      ).toBe(true);
    }
  });

  it("holds the last focus for 30 ticks after the operations stop, then heads home", () => {
    expect(FOCUS_HOLD_TICKS).toBe(30);
    const base = warmWorld(index);
    const op = {
      id: 1,
      technique: "T0865" as const,
      target: "corp-ws-dispatch",
      path: ["internet", "corp-mail", "corp-ws-dispatch"],
      links: ["l-net-mail", "l-mail-dispatch"],
      hop: 2,
      doneAt: 0,
    };
    const input = (ops: typeof base.ops) => ({
      world: { ...base, ops },
      zoneOfNode,
      layout,
      enabled: true,
      reducedMotion: false,
    });
    let state = stepCamera(homeCamera(layout), input([op]));
    expect(state.focus).toBe("z-corp");
    for (let i = 0; i < FOCUS_HOLD_TICKS - 1; i++) {
      state = stepCamera(state, input([]));
      expect(state.focus, `tick ${i}`).toBe("z-corp");
    }
    state = stepCamera(state, input([]));
    expect(state.focus).toBeUndefined();
  });

  it("eases by exactly 0.06 of the gap per tick, and by 0.15 when follow is off", () => {
    expect(CAMERA_EASE).toBe(0.06);
    expect(CAMERA_OFF_EASE).toBe(0.15);
    const base = warmWorld(index);
    const op = {
      id: 1,
      technique: "T0865" as const,
      target: "corp-ws-dispatch",
      path: ["internet", "corp-mail", "corp-ws-dispatch"],
      links: ["l-net-mail", "l-mail-dispatch"],
      hop: 2,
      doneAt: 0,
    };
    const input = (enabled: boolean) => ({
      world: { ...base, ops: [op] },
      zoneOfNode,
      layout,
      enabled,
      reducedMotion: false,
    });
    const target = focusPose("z-corp", layout);
    const on = stepCamera(homeCamera(layout), input(true));
    expect(on.zoom).toBe(1 + (target.zoom - 1) * CAMERA_EASE);
    expect(on.cx).toBe(layout.width / 2 + (target.cx - layout.width / 2) * CAMERA_EASE);
    // Follow off: toward home, 0.15 per tick, from wherever it was.
    const away30: CameraState = { ...homeCamera(layout), zoom: 1.3, cx: 600, cy: 300 };
    const off = stepCamera(away30, input(false));
    expect(off.zoom).toBe(1.3 + (1 - 1.3) * CAMERA_OFF_EASE);
    expect(off.cx).toBe(600 + (layout.width / 2 - 600) * CAMERA_OFF_EASE);
  });

  it("stays home exactly, every tick, with reduced motion", () => {
    const run = playCamera(0, 400, { reducedMotion: true });
    const home = homeCamera(layout);
    for (const s of run) {
      expect(s.state.zoom).toBe(home.zoom);
      expect(s.state.cx).toBe(home.cx);
      expect(s.state.cy).toBe(home.cy);
    }
  });

  it("stays home with follow off from the start", () => {
    const run = playCamera(0, 300, { enabled: false });
    for (const s of run) expect(away(s.state)).toBe(false);
  });
});

describe("the camera track", { timeout: 60000 }, () => {
  it("jumps home with no easing on reset and forgets focus, latch and baseline", () => {
    const track = new CameraTrack(layout);
    const entry = catalog[0];
    if (!entry) throw new Error("no scenario");
    const session = createAttractSession({ scenario: entry.scenario, recording: entry.recording });
    for (let i = 0; i < 150; i++) {
      session.advance(1);
      track.step({ world: session.world(), zoneOfNode, enabled: true, reducedMotion: false });
    }
    expect(away(track.current())).toBe(true);
    track.reset();
    expect(track.current()).toEqual(homeCamera(layout));
    expect(track.pose(0.5)).toEqual({ zoom: 1, cx: layout.width / 2, cy: layout.height / 2 });
  });

  it("interpolates between the last two steps with the loop's alpha", () => {
    const track = new CameraTrack(layout);
    const base = warmWorld(index);
    const op = {
      id: 1,
      technique: "T0865" as const,
      target: "corp-ws-dispatch",
      path: ["internet", "corp-mail", "corp-ws-dispatch"],
      links: ["l-net-mail", "l-mail-dispatch"],
      hop: 2,
      doneAt: 0,
    };
    track.step({ world: { ...base, ops: [op] }, zoneOfNode, enabled: true, reducedMotion: false });
    const now = track.current();
    expect(track.pose(0).zoom).toBe(1);
    expect(track.pose(1).zoom).toBe(now.zoom);
    expect(track.pose(0.5).zoom).toBeCloseTo((1 + now.zoom) / 2, 12);
  });
});

describe("measured camera ticks", { timeout: 60000 }, () => {
  it("leaves home within the first two seconds of every show and latches home in the phishing show before the 00:34 still", () => {
    const rows = catalog.map((entry, i) => {
      const run = playCamera(i, 700);
      const first = run.find((s) => away(s.state))?.elapsed;
      const latch = run.find((s) => s.state.latched)?.elapsed;
      const firstAway = run.findIndex((s) => away(s.state));
      const home = run.slice(Math.max(0, firstAway)).find((s) => isHome(s.state))?.elapsed;
      return { id: entry.scenario.id, first, latch, home };
    });
    for (const r of rows) {
      expect(r.first, r.id).toBeGreaterThanOrEqual(1);
      expect(r.first, r.id).toBeLessThanOrEqual(20);
    }
    const phishing = rows.find((r) => r.id === "phishing-dispatcher");
    expect(phishing?.latch).toBeGreaterThan(0);
    expect(phishing?.latch).toBeLessThan(340);
    expect(phishing?.home).toBeLessThan(340);
  });
});

describe("map labels under the camera zoom", () => {
  it("keep their CSS size, so every box at zoom 1.0 to 1.3 lies inside its box at home", () => {
    const marks = ctx.conduitMarks;
    let strictlySmaller = 0;
    for (let u = 0.5; u <= 1.1001; u += 0.1) {
      const home = placeLabels(layout, marks, u, 1);
      for (const zoom of [1, 1.1, 1.2, 1.3]) {
        const zoomed = placeLabels(layout, marks, u, zoom);
        expect(zoomed).toHaveLength(home.length);
        zoomed.forEach((label, i) => {
          const base = home[i];
          expect(base).toBeDefined();
          if (!base) return;
          expect(label.id).toBe(base.id);
          expect(label.box.x0, `${label.kind} ${label.id}`).toBeGreaterThanOrEqual(
            base.box.x0 - 1e-9,
          );
          expect(label.box.y0).toBeGreaterThanOrEqual(base.box.y0 - 1e-9);
          expect(label.box.x1).toBeLessThanOrEqual(base.box.x1 + 1e-9);
          expect(label.box.y1).toBeLessThanOrEqual(base.box.y1 + 1e-9);
          if (zoom === 1.3 && label.box.x1 - label.box.x0 < base.box.x1 - base.box.x0) {
            strictlySmaller++;
          }
        });
      }
    }
    expect(strictlySmaller).toBeGreaterThan(0);
  });

  it("leave the zoom-1 boxes exactly as the home collision proof computes them", () => {
    expect(placeLabels(layout, ctx.conduitMarks, 0.8)).toEqual(
      placeLabels(layout, ctx.conduitMarks, 0.8, 1),
    );
  });
});
