import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { fitMap, viewUniform } from "../../src/render/geometry";
import { introLevels } from "../../src/render/intro/levels";
import {
  CROSSFADE_MS,
  FADE_IN_END_MS,
  FALL_END_MS,
  FLARE_SLOT_MS,
  FOLD_END_MS,
  flareLevel,
  INTRO_MS,
  introPose,
  introSheet,
  LAYER_COUNT,
  layerMatrix,
  packetPoints,
  projectToClip,
  type ScreenBox,
  STACK_DEPTH,
  START_SHIFT,
  START_SHIFT_Y,
  START_TILT,
  screenBox,
  startScale,
} from "../../src/render/intro/pose";

const ASPECTS = [
  { name: "16:9", width: 1600, height: 900 },
  { name: "4:3", width: 1200, height: 900 },
  { name: "1:1", width: 900, height: 900 },
] as const;

const DEG = 180 / Math.PI;

/** The tuned numbers (UI-SPEC assumption 5): the tests, not the spec, hold them. */
const PINNED = {
  shift: -0.05,
  shiftY: -0.05,
  depth: 50,
  tiltDeg: 56,
  scale: { "16:9": 0.665, "4:3": 0.7, "1:1": 0.72 },
} as const;

describe("the intro timeline", () => {
  it("is 4000 ms: fade in to 600, fall to 2400, fold to 3600, cross-fade to 4000", () => {
    expect(INTRO_MS).toBe(4000);
    expect(FADE_IN_END_MS).toBe(600);
    expect(FALL_END_MS).toBe(2400);
    expect(FOLD_END_MS).toBe(3600);
    expect(CROSSFADE_MS).toBe(400);
    expect(FOLD_END_MS + CROSSFADE_MS).toBe(INTRO_MS);
  });
});

describe("the intro pose", () => {
  for (const a of ASPECTS) {
    const aspect = a.width / a.height;

    it(`${a.name}: starts tilted between 50 and 65 degrees`, () => {
      const theta = introPose(0, aspect).theta * DEG;
      expect(theta).toBeGreaterThanOrEqual(50);
      expect(theta).toBeLessThanOrEqual(65);
    });

    it(`${a.name}: drifts by at most 1.5 degrees before the fold`, () => {
      const start = introPose(0, aspect).theta * DEG;
      for (let t = 0; t <= FALL_END_MS; t += 10) {
        expect(Math.abs(introPose(t, aspect).theta * DEG - start)).toBeLessThanOrEqual(1.5);
      }
    });

    it(`${a.name}: tilt never increases and scale never decreases from the start of the fold`, () => {
      let prev = introPose(FALL_END_MS, aspect);
      for (let t = FALL_END_MS; t <= INTRO_MS; t += 10) {
        const pose = introPose(t, aspect);
        expect(pose.theta).toBeLessThanOrEqual(prev.theta + 1e-12);
        expect(pose.separation).toBeLessThanOrEqual(prev.separation + 1e-12);
        expect(pose.scale).toBeGreaterThanOrEqual(prev.scale - 1e-12);
        prev = pose;
      }
    });

    it(`${a.name}: is exactly flat from 3600 ms`, () => {
      for (const t of [FOLD_END_MS, 3700, INTRO_MS]) {
        const pose = introPose(t, aspect);
        expect(pose.theta).toBe(0);
        expect(pose.separation).toBe(0);
        expect(pose.scale).toBe(1);
        expect(pose.foldProgress).toBe(1);
      }
    });

    it(`${a.name}: the layer matrix at the end of the fold is the live 2D fit within 1e-6`, () => {
      const fit = fitMap(a.width, a.height, layout.width, layout.height);
      const live = viewUniform(fit, a.width, a.height);
      const sheet = introSheet([{ x: 0, y: 0, w: layout.width, h: layout.height }], layout);
      const points = [
        [0, 0],
        [layout.width, layout.height],
        [800, 450],
        [123.5, 777.25],
        [1490, 40],
        [20, 885],
      ] as const;
      for (const t of [FOLD_END_MS, INTRO_MS]) {
        const m = layerMatrix(
          introPose(t, aspect),
          0,
          fit,
          { width: a.width, height: a.height },
          sheet,
        );
        for (const [x, y] of points) {
          const p = projectToClip(m, x, y);
          expect(p.x).toBeCloseTo(x * live[0] + live[2], 6);
          expect(p.y).toBeCloseTo(y * live[1] + live[3], 6);
          expect(Math.abs(p.x - (x * live[0] + live[2]))).toBeLessThan(1e-6);
          expect(Math.abs(p.y - (y * live[1] + live[3]))).toBeLessThan(1e-6);
          expect(p.w).toBeCloseTo(1, 9);
        }
      }
    });

    it(`${a.name}: every sampled point has a positive w during the whole intro`, () => {
      const fit = fitMap(a.width, a.height, layout.width, layout.height);
      const sheet = introSheet([{ x: 0, y: 0, w: layout.width, h: layout.height }], layout);
      for (let t = 0; t <= INTRO_MS; t += 100) {
        const m = layerMatrix(introPose(t, aspect), 0, fit, a, sheet);
        for (const [x, y] of [
          [0, 0],
          [layout.width, 0],
          [0, layout.height],
          [layout.width, layout.height],
        ] as const) {
          expect(projectToClip(m, x, y).w).toBeGreaterThan(0.2);
        }
      }
    });
  }

  it("fades in over the first 600 ms and brings the labels in only after the fold", () => {
    expect(introPose(0, 1.6).fadeIn).toBe(0);
    expect(introPose(300, 1.6).fadeIn).toBeGreaterThan(0);
    expect(introPose(300, 1.6).fadeIn).toBeLessThan(1);
    expect(introPose(600, 1.6).fadeIn).toBe(1);
    expect(introPose(3599, 1.6).labelsAlpha).toBe(0);
    expect(introPose(3600, 1.6).labelsAlpha).toBe(0);
    expect(introPose(3800, 1.6).labelsAlpha).toBeCloseTo(0.5, 9);
    expect(introPose(4000, 1.6).labelsAlpha).toBe(1);
  });

  it("brings the bridges in only over the last 40 percent of the fold", () => {
    expect(introPose(2400, 1.6).bridgesAlpha).toBe(0);
    expect(introPose(2400 + 0.6 * 1200, 1.6).bridgesAlpha).toBe(0);
    expect(introPose(3200, 1.6).bridgesAlpha).toBeGreaterThan(0);
    expect(introPose(3600, 1.6).bridgesAlpha).toBeCloseTo(1, 9);
  });
});

describe("the five layers in the pose", () => {
  const levels = introLevels(network, layout);
  const plates = levels.map((l) => l.plate);
  const sheet = introSheet(plates, layout);

  const boxesAt = (t: number, a: (typeof ASPECTS)[number]) => {
    const fit = fitMap(a.width, a.height, layout.width, layout.height);
    const pose = introPose(t, a.width / a.height);
    return plates.map((plate, i) =>
      screenBox(layerMatrix(pose, i, fit, { width: a.width, height: a.height }, sheet), plate, a),
    );
  };

  for (const a of ASPECTS) {
    it(`${a.name}: every layer stays inside the canvas with 4 percent margin while it hangs`, () => {
      for (let t = 0; t <= FALL_END_MS; t += 10) {
        for (const [i, b] of boxesAt(t, a).entries()) {
          expect(b.x0, `t ${t} layer ${i} left`).toBeGreaterThanOrEqual(0.04 * a.width);
          expect(b.x1, `t ${t} layer ${i} right`).toBeLessThanOrEqual(0.96 * a.width);
          expect(b.y0, `t ${t} layer ${i} top`).toBeGreaterThanOrEqual(0.04 * a.height);
          expect(b.y1, `t ${t} layer ${i} bottom`).toBeLessThanOrEqual(0.96 * a.height);
        }
      }
    });

    it(`${a.name}: the stack reads top to bottom and neighbours overlap by at most 15 percent`, () => {
      for (let t = 0; t <= FALL_END_MS; t += 10) {
        const boxes = boxesAt(t, a);
        for (let i = 0; i + 1 < boxes.length; i++) {
          const upper = boxes[i] as ScreenBox;
          const lower = boxes[i + 1] as ScreenBox;
          expect((upper.y0 + upper.y1) / 2, `t ${t} order ${i}`).toBeLessThan(
            (lower.y0 + lower.y1) / 2,
          );
          const overlap = Math.max(0, Math.min(upper.y1, lower.y1) - Math.max(upper.y0, lower.y0));
          const shorter = Math.min(upper.y1 - upper.y0, lower.y1 - lower.y0);
          expect(overlap, `t ${t} layers ${i} and ${i + 1}`).toBeLessThanOrEqual(0.15 * shorter);
        }
      }
    });

    it(`${a.name}: at the end of the fold every layer is the live fit, and the plates are gone`, () => {
      const fit = fitMap(a.width, a.height, layout.width, layout.height);
      const live = viewUniform(fit, a.width, a.height);
      for (const t of [FOLD_END_MS, INTRO_MS]) {
        const pose = introPose(t, a.width / a.height);
        for (let i = 0; i < LAYER_COUNT; i++) {
          const m = layerMatrix(pose, i, fit, { width: a.width, height: a.height }, sheet);
          for (const [x, y] of [
            [0, 0],
            [1600, 900],
            [725, 180],
            [455, 570],
          ] as const) {
            const p = projectToClip(m, x, y);
            expect(Math.abs(p.x - (x * live[0] + live[2])), `layer ${i}`).toBeLessThan(1e-6);
            expect(Math.abs(p.y - (y * live[1] + live[3])), `layer ${i}`).toBeLessThan(1e-6);
          }
        }
        expect(pose.plateAlpha).toBe(0);
        expect(pose.namesAlpha).toBe(0);
      }
    });
  }

  it("packs the layers down the sheet in order", () => {
    expect(sheet.stack.length).toBe(LAYER_COUNT);
    const centres = sheet.stack.map((s, i) => {
      const p = plates[i] as (typeof plates)[number];
      return p.y + p.h / 2 + s.dv;
    });
    for (let i = 0; i + 1 < centres.length; i++) {
      expect(centres[i] as number).toBeLessThan(centres[i + 1] as number);
    }
  });

  it("hangs the top layer nearest the viewer", () => {
    const dz = sheet.stack.map((s) => s.dz);
    for (let i = 0; i + 1 < dz.length; i++) {
      expect(dz[i] as number).toBeGreaterThan(dz[i + 1] as number);
    }
  });

  it("pins the tuned numbers", () => {
    expect(START_SHIFT).toBe(PINNED.shift);
    expect(START_SHIFT_Y).toBe(PINNED.shiftY);
    expect(STACK_DEPTH).toBe(PINNED.depth);
    expect(START_TILT * DEG).toBeCloseTo(PINNED.tiltDeg, 9);
    for (const a of ASPECTS) {
      expect(startScale(a.width / a.height), a.name).toBeCloseTo(PINNED.scale[a.name], 9);
    }
  });
});

describe("the layer flares", () => {
  it("are non-zero only inside the layer's own 360 ms slot, from 600 ms", () => {
    expect(FLARE_SLOT_MS).toBe(360);
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const start = FADE_IN_END_MS + FLARE_SLOT_MS * layer;
      for (let t = 0; t <= INTRO_MS; t += 5) {
        const level = flareLevel(layer, t);
        if (t <= start || t >= start + FLARE_SLOT_MS) {
          expect(level, `layer ${layer} t ${t}`).toBe(0);
        } else {
          expect(level, `layer ${layer} t ${t}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("rise once and fall once in the slot, peaking at 1 in the middle", () => {
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const start = FADE_IN_END_MS + FLARE_SLOT_MS * layer;
      expect(flareLevel(layer, start + FLARE_SLOT_MS / 2)).toBeCloseTo(1, 9);
      let changes = 0;
      let dir = 0;
      let prev = 0;
      for (let t = start; t <= start + FLARE_SLOT_MS; t += 1) {
        const v = flareLevel(layer, t);
        const d = Math.sign(v - prev);
        if (d !== 0 && dir !== 0 && d !== dir) changes++;
        if (d !== 0) dir = d;
        prev = v;
      }
      expect(changes).toBe(1);
    }
  });

  it("never light two layers at once and flash at most 3 times a second", () => {
    for (let t = 0; t <= INTRO_MS; t += 1) {
      const lit = introPose(t, 1.6).flares.filter((v) => v > 0).length;
      expect(lit, `t ${t}`).toBeLessThanOrEqual(1);
    }
    expect(introPose(780, 1.6).flares[0]).toBeCloseTo(1, 9);
    // Five flares inside 1800 ms is 2.78 a second.
    expect(1000 / FLARE_SLOT_MS).toBeLessThanOrEqual(3);
  });
});

describe("the falling packet", () => {
  const anchors = Array.from({ length: LAYER_COUNT }, (_, i) => ({ x: 500, y: 100 + 130 * i }));

  it("is not there before 600 ms or after 2400 ms", () => {
    expect(packetPoints(599, anchors)).toEqual([]);
    expect(packetPoints(2401, anchors)).toEqual([]);
    expect(packetPoints(600, anchors).length).toBeGreaterThan(0);
  });

  it("reaches layer i at the middle of its slot", () => {
    for (let i = 0; i < LAYER_COUNT; i++) {
      const t = FADE_IN_END_MS + FLARE_SLOT_MS * i + FLARE_SLOT_MS / 2;
      const head = packetPoints(t, anchors)[0] as { x: number; y: number };
      expect(head.x).toBeCloseTo(500, 9);
      expect(head.y).toBeCloseTo(anchors[i]?.y ?? 0, 9);
    }
  });

  it("falls monotonically and carries a comet of 6 samples trailing the head", () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let t = 700; t <= 2300; t += 10) {
      const points = packetPoints(t, anchors);
      expect(points.length).toBe(6);
      const head = points[0] as { y: number };
      expect(head.y).toBeGreaterThanOrEqual(prev);
      prev = head.y;
      for (let k = 1; k < points.length; k++) {
        expect((points[k] as { y: number }).y).toBeLessThanOrEqual(
          (points[k - 1] as { y: number }).y,
        );
      }
    }
  });
});
