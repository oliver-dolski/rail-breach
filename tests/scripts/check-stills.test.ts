import { describe, expect, it } from "vitest";
import {
  boardDiff,
  boxMask,
  brightClearance,
  compensatedMean,
  G3_MEAN_MAX,
  G3_P95_MAX,
  G4_BORDER_CLEARANCE_UNITS,
  G4_GLOW_CLEARANCE_PX,
  G4_MAX_DELTA,
  G4_MIN_SAMPLES,
  G4_TINT_CHROMA,
  G4_WINDOW_RADIUS,
  isTinted,
  labelBackdropStats,
  NEW_VIGNETTE,
  OLD_VIGNETTE,
  relativeLuminance,
  vignetteFactor,
  zoneAt,
  zoneBorderDistance,
} from "../../scripts/check-stills.mjs";

/** A flat rgb24 image. */
function flat(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) out.set(rgb, i * 3);
  return out;
}

describe("the stills gates (UI-SPEC G3 and G4)", () => {
  it("pins the thresholds the plan names", () => {
    expect(G3_MEAN_MAX).toBe(0.05);
    expect(G3_P95_MAX).toBe(0.09);
    expect(G4_MAX_DELTA).toBe(2);
    expect(G4_GLOW_CLEARANCE_PX).toBe(24);
    expect(G4_WINDOW_RADIUS).toBe(2);
    expect(G4_BORDER_CLEARANCE_UNITS).toBe(14);
    expect(G4_TINT_CHROMA).toBe(2);
    expect(G4_MIN_SAMPLES).toBe(1000);
    expect(OLD_VIGNETTE).toBe(0.35);
    expect(NEW_VIGNETTE).toBe(0.28);
  });

  describe("relativeLuminance", () => {
    it("is 0 for black and 1 for white", () => {
      expect(relativeLuminance(0, 0, 0)).toBe(0);
      expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 10);
    });

    it("keeps the ground colour of the map far below the legibility ceiling", () => {
      expect(relativeLuminance(7, 9, 13)).toBeLessThan(0.004);
    });

    it("weights green over red over blue", () => {
      expect(relativeLuminance(0, 255, 0)).toBeGreaterThan(relativeLuminance(255, 0, 0));
      expect(relativeLuminance(255, 0, 0)).toBeGreaterThan(relativeLuminance(0, 0, 255));
    });
  });

  describe("labelBackdropStats", () => {
    it("measures only the pixels inside the boxes", () => {
      const width = 20;
      const height = 10;
      const image = flat(width, height, [0, 0, 0]);
      // One bright 2 x 2 patch inside the box, bright pixels outside it that must not count.
      for (const [x, y] of [
        [2, 2],
        [3, 2],
        [2, 3],
        [3, 3],
        [15, 8],
      ] as const) {
        image.set([255, 255, 255], (y * width + x) * 3);
      }
      const stats = labelBackdropStats(image, width, [{ x: 0, y: 0, w: 10, h: 5 }]);
      expect(stats.count).toBe(50);
      expect(stats.mean).toBeCloseTo(4 / 50, 10);
      // 4 of 50 pixels are white: the 95th percentile (index 47 of 50) is white.
      expect(stats.p95).toBeCloseTo(1, 10);
    });

    it("counts a pixel once when boxes overlap", () => {
      const image = flat(10, 10, [255, 255, 255]);
      const stats = labelBackdropStats(image, 10, [
        { x: 0, y: 0, w: 6, h: 6 },
        { x: 4, y: 4, w: 6, h: 6 },
      ]);
      expect(stats.count).toBe(36 + 36 - 4);
      expect(stats.mean).toBeCloseTo(1, 10);
    });

    it("clips boxes to the image and reports no pixels for an empty list", () => {
      const image = flat(8, 8, [0, 0, 0]);
      expect(labelBackdropStats(image, 8, [{ x: -5, y: -5, w: 10, h: 10 }]).count).toBe(25);
      expect(labelBackdropStats(image, 8, [])).toEqual({ mean: 0, p95: 0, count: 0 });
    });
  });

  describe("vignetteFactor", () => {
    it("is 1 at the centre and 1 - depth at a corner", () => {
      expect(vignetteFactor(OLD_VIGNETTE, 50, 50, 100, 100)).toBeCloseTo(1, 12);
      expect(vignetteFactor(OLD_VIGNETTE, 0, 0, 100, 100)).toBeCloseTo(0.65, 12);
      expect(vignetteFactor(NEW_VIGNETTE, 100, 100, 100, 100)).toBeCloseTo(0.72, 12);
    });
  });

  describe("brightClearance", () => {
    it("marks pixels within the radius of a bright pixel in either image, and no others", () => {
      const width = 40;
      const height = 40;
      const dim = flat(width, height, [30, 30, 30]);
      const lit = flat(width, height, [30, 30, 30]);
      lit.set([200, 200, 200], (20 * width + 20) * 3);
      const near = brightClearance([dim, lit], width, height, 140, 5);
      expect(near[20 * width + 20]).toBe(1);
      expect(near[20 * width + 25]).toBe(1);
      expect(near[20 * width + 26]).toBe(0);
      expect(near[0]).toBe(0);
    });

    it("skips the pixels an ignore mask names, such as page text", () => {
      const width = 20;
      const height = 20;
      const image = flat(width, height, [10, 10, 10]);
      image.set([250, 250, 250], (10 * width + 10) * 3);
      const mask = boxMask([{ x: 9, y: 9, w: 3, h: 3 }], width, height);
      const near = brightClearance([image], width, height, 140, 4, [mask]);
      expect(near.every((v) => v === 0)).toBe(true);
    });

    it("does not mark anything when nothing is brighter than the threshold", () => {
      const image = flat(10, 10, [140, 140, 140]);
      expect(brightClearance([image], 10, 10, 140, 3).every((v) => v === 0)).toBe(true);
    });
  });

  describe("boardDiff", () => {
    const width = 64;
    const height = 48;
    const canvas = { x: 0, y: 0, w: width, h: height };

    /** The same flat board shown through each build's own vignette, as 8-bit values. */
    function vignetted(depth: number, level: number): Uint8Array {
      const image = new Uint8Array(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = Math.round(level * vignetteFactor(depth, x + 0.5, y + 0.5, width, height));
          image.set([v, v, v], (y * width + x) * 3);
        }
      }
      return image;
    }

    const samples: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y += 3) for (let x = 0; x < width; x += 3) samples.push({ x, y });

    it("sees no board change when only the two vignettes differ", () => {
      const old = vignetted(OLD_VIGNETTE, 110);
      const next = vignetted(NEW_VIGNETTE, 110);
      const result = boardDiff(old, next, samples, { width, canvas });
      expect(result.compared).toBe(samples.length);
      // Rounding to 8 bits on each side, divided by the factors 0.65 and 0.72 at a corner, is the
      // only difference left: at most 0.5 / 0.65 + 0.5 / 0.72, about 1.46.
      expect(result.maxDelta).toBeLessThanOrEqual(1.5);
      // Without the compensation the two vignettes would differ by 7 levels at a corner.
      const raw = boardDiff(old, next, samples, { width, canvas, oldDepth: 0, newDepth: 0 });
      expect(raw.maxDelta).toBeGreaterThan(6);
    });

    it("reports a 3-level change at one sample with its position", () => {
      const old = vignetted(OLD_VIGNETTE, 110);
      const next = vignetted(NEW_VIGNETTE, 110);
      const at = { x: 30, y: 24 };
      const index = (at.y * width + at.x) * 3;
      next[index + 1] = (next[index + 1] ?? 0) + 3;
      const result = boardDiff(old, next, [...samples, at], { width, canvas });
      expect(result.maxDelta).toBeGreaterThan(G4_MAX_DELTA);
      expect(result.worst[0]).toMatchObject({ x: 30, y: 24, channel: 1 });
    });

    it("cancels zero-mean noise with a 3 x 3 mean and leaves a real change standing", () => {
      const old = flat(width, height, [100, 100, 100]);
      const noisy = new Uint8Array(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = 100 + ((x + y) % 2 === 0 ? 3 : -3);
          noisy.set([v, v, v], (y * width + x) * 3);
        }
      }
      const inner = samples.filter(
        (s) => s.x > 3 && s.y > 3 && s.x < width - 4 && s.y < height - 4,
      );
      const options = { width, canvas, oldDepth: 0, newDepth: 0 };
      expect(boardDiff(old, noisy, inner, options).maxDelta).toBeGreaterThan(G4_MAX_DELTA);
      expect(boardDiff(old, noisy, inner, { ...options, radius: 1 }).maxDelta).toBeLessThan(0.5);
      // A real level shift of 4 survives the averaging.
      const lifted = flat(width, height, [104, 104, 104]);
      expect(boardDiff(old, lifted, inner, { ...options, radius: 1 }).maxDelta).toBeCloseTo(4, 6);
    });

    it("leaves out samples that are not on the canvas", () => {
      const old = vignetted(OLD_VIGNETTE, 110);
      const result = boardDiff(old, old, [{ x: 500, y: 500 }], { width, canvas });
      expect(result.compared).toBe(0);
      expect(result.maxDelta).toBe(0);
    });
  });

  describe("compensatedMean", () => {
    it("divides each pixel by its own vignette and clips the window to the canvas", () => {
      const width = 10;
      const canvas = { x: 0, y: 0, w: 10, h: 10 };
      const image = flat(width, 10, [90, 90, 90]);
      const corner = compensatedMean(image, width, canvas, 0.35, 0, 0, 1);
      expect(corner[0]).toBeGreaterThan(90);
      // Four pixels in the window at the corner, each near the corner factor.
      const centre = compensatedMean(image, width, canvas, 0.35, 5, 5, 0);
      expect(centre[0]).toBeCloseTo(90 / vignetteFactor(0.35, 5.5, 5.5, 10, 10), 10);
    });
  });

  describe("zones", () => {
    const zones = [
      { id: "a", x: 100, y: 100, w: 200, h: 100 },
      { id: "b", x: 400, y: 100, w: 100, h: 100 },
    ];

    it("measures the distance to the nearest border from inside and from outside", () => {
      expect(zoneBorderDistance(zones, 150, 150)).toBe(50);
      expect(zoneBorderDistance(zones, 110, 150)).toBe(10);
      expect(zoneBorderDistance(zones, 340, 150)).toBe(40);
      expect(zoneBorderDistance(zones, 90, 90)).toBeCloseTo(Math.hypot(10, 10), 10);
    });

    it("finds the zone that holds a point", () => {
      expect(zoneAt(zones, 150, 150)?.id).toBe("a");
      expect(zoneAt(zones, 450, 150)?.id).toBe("b");
      expect(zoneAt(zones, 350, 150)).toBeUndefined();
    });

    it("calls a pane tinted only when its channels shifted unequally", () => {
      // The plain pane of the new build lifts every channel by the same amount.
      expect(isTinted([5.5, 5.8, 5.6])).toBe(false);
      // The attacker tint lifts red and blue more than green.
      expect(isTinted([15.1, 8.7, 12.9])).toBe(true);
    });
  });
});
