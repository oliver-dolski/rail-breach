import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import type { SimEvent } from "../../src/core/sim/events";
import {
  AlertFlashes,
  FLASH_HOLD_TICKS,
  FLASH_MIN_GAP_TICKS,
  FLASH_TICKS,
  flashLevel,
  MAX_FLASH_RATE,
  MAX_FLASHES_PER_SECOND,
} from "../../src/render/flashes";
import { ALERT_COLORS, hueDistance, hueOf, SIGNAL_HUES } from "../../src/render/palette";
import { buildView, createViewContext } from "../../src/render/view";
import { networkIndex, warmWorld } from "../fixtures/attack";

const alert = (tick: number, link = "l-dmz-hmi1"): SimEvent => ({
  k: "ids.alert",
  tick,
  op: 1,
  technique: "T0886",
  legacyId: "",
  link,
  conduit: "c-dmz-ctrl",
  sensor: "baseline",
});

/** Local maxima above one half in a sampled brightness curve. */
function peaks(samples: readonly number[]): number {
  let count = 0;
  for (let i = 1; i < samples.length - 1; i++) {
    const v = samples[i] ?? 0;
    if (v > 0.5 && v > (samples[i - 1] ?? 0) && v >= (samples[i + 1] ?? 0)) count++;
  }
  return count;
}

function curve(flashes: AlertFlashes, from: number, to: number, reduced: boolean): number[] {
  const out: number[] = [];
  for (let phase = from; phase <= to; phase += 0.05) {
    out.push(flashes.levels(phase, reduced).find((l) => l.link === "l-dmz-hmi1")?.level ?? 0);
  }
  return out;
}

describe("IDS alert flashes", () => {
  it("never pulse faster than 3 a second, however fast the alerts come", () => {
    expect(MAX_FLASH_RATE).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    for (const every of [1, 2, 3, 4, 7]) {
      const flashes = new AlertFlashes();
      const events: SimEvent[] = [];
      for (let tick = 100; tick < 400; tick += every) events.push(alert(tick));
      flashes.ingest(events);
      // The last three pulses are all that is kept, so look at the stretch they cover.
      const samples = curve(flashes, 388, 399, false);
      const seconds = (399 - 388) / 10;
      expect(peaks(samples) / seconds, `every ${every} ticks`).toBeLessThanOrEqual(3);
    }
  });

  it("pulses once for one alert and leaves the link faintly lit afterwards", () => {
    const flashes = new AlertFlashes();
    flashes.ingest([alert(100)]);
    const samples = curve(flashes, 100, 100 + FLASH_TICKS, false);
    expect(peaks(samples)).toBe(1);
    expect(Math.max(...samples)).toBeGreaterThan(0.95);
    const later = flashes.levels(100 + FLASH_TICKS + 10, false);
    expect(later[0]?.level).toBeGreaterThan(0);
    expect(later[0]?.level).toBeLessThan(0.35);
    expect(flashes.levels(100 + FLASH_HOLD_TICKS + 1, false)).toEqual([]);
  });

  it("is calmer under reduced motion: one steady glow that fades, no pulsing", () => {
    const flashes = new AlertFlashes();
    flashes.ingest([alert(100), alert(110), alert(120)]);
    const samples = curve(flashes, 120, 120 + FLASH_HOLD_TICKS, true);
    // Never brighter than the full-motion pulse and never more than one maximum.
    expect(Math.max(...samples)).toBeLessThan(0.8);
    expect(peaks(samples)).toBeLessThanOrEqual(1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i] ?? 0).toBeLessThanOrEqual((samples[i - 1] ?? 0) + 1e-9);
    }
  });

  it("folds an alert that would start a pulse too soon into the one before", () => {
    const flashes = new AlertFlashes();
    flashes.ingest([alert(100), alert(100 + FLASH_MIN_GAP_TICKS - 1)]);
    const lone = new AlertFlashes();
    lone.ingest([alert(100)]);
    expect(flashes.levels(103, false)).toEqual(lone.levels(103, false));
  });

  it("is a pure function of the alert ticks and the phase", () => {
    expect(flashLevel([100, 110], 113, false)).toBe(flashLevel([100, 110], 113, false));
    expect(flashLevel([], 100, false)).toBe(0);
    expect(flashLevel([100], 99, false)).toBe(0);
  });

  it("clears on a restart", () => {
    const flashes = new AlertFlashes();
    flashes.ingest([alert(100)]);
    flashes.clear();
    expect(flashes.levels(102, false)).toEqual([]);
  });

  it("ignores every event that is not an alert", () => {
    const flashes = new AlertFlashes();
    flashes.ingest([{ k: "action.rejected", tick: 100, reason: "unknown-node" }]);
    expect(flashes.levels(101, false)).toEqual([]);
  });
});

describe("IDS alerts on the map", () => {
  const index = networkIndex();
  const ctx = createViewContext(network, index, layout);

  it("light the link in the detection hue, which no signal lamp shares", () => {
    const view = buildView(warmWorld(index), ctx, { alerts: [{ link: "l-dmz-hmi1", level: 1 }] });
    expect(view.alerts).toHaveLength(1);
    const [line] = view.alerts;
    const hue = hueOf([line?.color[0] ?? 0, line?.color[1] ?? 0, line?.color[2] ?? 0]);
    expect(hue).not.toBeNull();
    expect(hueDistance(hue ?? 0, 186)).toBeLessThan(6);
    for (const signal of Object.values(SIGNAL_HUES)) {
      expect(hueDistance(hue ?? 0, signal)).toBeGreaterThan(40);
    }
    expect(ALERT_COLORS.detection).toBeDefined();
  });

  it("draw nothing without alerts, and skip a link the layout does not have", () => {
    const world = warmWorld(index);
    expect(buildView(world, ctx).alerts).toEqual([]);
    expect(buildView(world, ctx, { alerts: [{ link: "l-nowhere", level: 1 }] }).alerts).toEqual([]);
  });
});
