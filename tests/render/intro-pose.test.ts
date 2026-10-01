import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { fitMap, viewUniform } from "../../src/render/geometry";
import {
  CROSSFADE_MS,
  FADE_IN_END_MS,
  FALL_END_MS,
  FOLD_END_MS,
  INTRO_MS,
  introPose,
  introSheet,
  layerMatrix,
  projectToClip,
} from "../../src/render/intro/pose";

const ASPECTS = [
  { name: "16:9", width: 1600, height: 900 },
  { name: "4:3", width: 1200, height: 900 },
  { name: "1:1", width: 900, height: 900 },
] as const;

const DEG = 180 / Math.PI;

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
