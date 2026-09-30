import type { LinkDef } from "../../content/types";
import { chance, internKey } from "../rng";
import {
  BASELINE_SENSOR_COVERAGE_PERMILLE,
  PERMILLE,
  PURPOSE_DETECT,
  SENSOR_COVERAGE_PERMILLE,
} from "../sim/constants";
import type { SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import type { World } from "../sim/world";

/**
 * The intrusion detection side. It only reads what happened this tick (the packets the
 * operations sent, from the events of the step) and the defenses in the world, and it
 * writes two things: ids.alert events and the two clock fields of the world. It never
 * touches a node, a lock, an aspect, a point or a train, and it cannot change what an
 * operation does: detection here is a measurement, not a defense that acts.
 *
 * Every roll is a pure function of (seed, tick, technique, link, purpose, operation), so
 * a replay from the same seed raises the same alerts on the same ticks. A placed sensor
 * raises the chance on its link without changing the dice, so adding one can only add
 * alerts, never take one away or move it.
 */

/** The share of a hop that is noticed, in permille: loudness, then sensor, then what it can read. */
export function detectionPermille(
  signaturePermille: number,
  coveragePermille: number,
  visibilityPermille: number,
): number {
  const afterSensor = Math.floor((signaturePermille * coveragePermille) / PERMILLE);
  return Math.floor((afterSensor * visibilityPermille) / PERMILLE);
}

/** The sensor watching a link at `tick`: a placed one that is in force, else the baseline. */
function sensorOn(world: World, link: LinkDef, tick: number): { id: string; coverage: number } {
  for (const defense of world.defenses) {
    if (defense.kind === "ids" && defense.link === link.id && tick >= defense.activeFrom) {
      return { id: defense.id, coverage: SENSOR_COVERAGE_PERMILLE };
    }
  }
  return { id: "baseline", coverage: BASELINE_SENSOR_COVERAGE_PERMILLE };
}

/**
 * Rolls the detection of every hop the operations sent this tick. The first operation
 * that starts sets firstActionTick; the first alert sets detectedAt. Runs after the
 * operations have moved, so it sees every packet of the tick, launches included.
 */
export function stepDetect(world: World, index: Index, events: SimEvent[]): void {
  const tick = world.tick;
  // Alerts are pushed onto the same list: only what was there on entry is read.
  const seen = events.length;
  for (let i = 0; i < seen; i++) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.k === "op.started" && world.firstActionTick === 0) {
      world.firstActionTick = event.tick;
      continue;
    }
    if (event.k !== "packet") continue;

    const def = index.techniques.get(event.technique);
    const link = index.net.linkById.get(event.link);
    if (def === undefined || link === undefined) continue;
    const sensor = sensorOn(world, link, tick);
    const permille = detectionPermille(
      def.signaturePermille,
      sensor.coverage,
      link.visibilityPermille ?? PERMILLE,
    );
    const noticed = chance(
      permille,
      world.seed,
      tick,
      internKey(def.id),
      internKey(link.id),
      PURPOSE_DETECT,
      event.op,
    );
    if (!noticed) continue;
    if (world.detectedAt === 0) world.detectedAt = tick;
    events.push({
      k: "ids.alert",
      tick,
      op: event.op,
      technique: def.id,
      legacyId: def.legacyId ?? "",
      link: link.id,
      conduit: link.conduit ?? "",
      sensor: sensor.id,
    });
  }
}
