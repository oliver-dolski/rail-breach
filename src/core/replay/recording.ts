import { type Action, isAction } from "../sim/actions";

/**
 * Durable recording format (decision confirmed before any recording existed):
 * inputs and hash checkpoints only. Derived events are never stored, and no key,
 * free text or model output may ever enter this structure.
 *
 * Tick semantics: an action with t = k is applied by the step that produces
 * world.tick === k. A checkpoint {t, h} is stateHash(world) once world.tick === t.
 * Live play stamps t = world.tick + 1 when an action is dispatched.
 *
 * Changing this shape needs a schema bump and regeneration of every recording.
 */
export const RECORDING_FORMAT = "rail-breach.recording";
export const RECORDING_SCHEMA = 1;

export interface TimedAction {
  t: number;
  a: Action;
}

export interface Checkpoint {
  t: number;
  h: string;
}

export interface Recording {
  format: typeof RECORDING_FORMAT;
  schema: typeof RECORDING_SCHEMA;
  seed: number;
  tickMs: 100;
  durationTicks: number;
  actions: TimedAction[];
  checkpoints: Checkpoint[];
}

/** Upper bounds on a recording's arrays. A committed recording is far below them. */
export const MAX_RECORDED_ACTIONS = 100_000;
export const MAX_RECORDED_CHECKPOINTS = 100_000;

const HASH_FORMAT = /^[0-9a-f]{8}$/;

const isUint = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Validates a parsed recording before the engine sees it. Throws on the first
 * problem: a corrupted or hostile file is rejected, not half-ignored.
 */
export function assertRecording(value: unknown): asserts value is Recording {
  if (typeof value !== "object" || value === null) throw new Error("recording: not an object");
  const r = value as Record<string, unknown>;
  if (r.format !== RECORDING_FORMAT) throw new Error("recording: wrong format");
  if (r.schema !== RECORDING_SCHEMA) throw new Error(`recording: unsupported schema ${r.schema}`);
  if (r.tickMs !== 100) throw new Error("recording: tickMs must be 100");
  if (!isUint(r.seed)) throw new Error("recording: seed must be a non-negative integer");
  if (!isUint(r.durationTicks)) throw new Error("recording: durationTicks must be an integer");
  if (!Array.isArray(r.actions)) throw new Error("recording: actions must be an array");
  if (r.actions.length > MAX_RECORDED_ACTIONS) {
    throw new Error(`recording: more than ${MAX_RECORDED_ACTIONS} actions`);
  }
  for (const item of r.actions as unknown[]) {
    const x = item as { t?: unknown; a?: unknown } | null;
    if (typeof x !== "object" || x === null || !isUint(x.t) || x.t < 1) {
      throw new Error("recording: action tick must be an integer >= 1");
    }
    if (x.t > r.durationTicks) {
      throw new Error("recording: action is after the end of the recording and would never run");
    }
    if (!isAction(x.a)) throw new Error("recording: unknown or malformed action");
  }
  if (!Array.isArray(r.checkpoints)) throw new Error("recording: checkpoints must be an array");
  if (r.checkpoints.length > MAX_RECORDED_CHECKPOINTS) {
    throw new Error(`recording: more than ${MAX_RECORDED_CHECKPOINTS} checkpoints`);
  }
  let lastCheckpoint = 0;
  for (const item of r.checkpoints as unknown[]) {
    const x = item as { t?: unknown; h?: unknown } | null;
    if (typeof x !== "object" || x === null || !isUint(x.t) || typeof x.h !== "string") {
      throw new Error("recording: malformed checkpoint");
    }
    if (!HASH_FORMAT.test(x.h)) {
      throw new Error("recording: checkpoint hash must be 8 lowercase hex digits");
    }
    if (x.t <= lastCheckpoint) {
      throw new Error("recording: checkpoint ticks must be unique and increasing");
    }
    lastCheckpoint = x.t;
  }
}
