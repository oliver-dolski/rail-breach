import type { Index } from "../sim/model";
import type { World } from "../sim/world";
import { RECORDING_FORMAT, RECORDING_SCHEMA, type Recording, type TimedAction } from "./recording";
import { createRunner } from "./runner";
import { RecordedSource } from "./source";

/**
 * Runs the real engine over a list of timed actions and returns the durable
 * recording: the inputs plus the hash checkpoints the run produced. The result
 * holds nothing that is not an input or a hash, so it is safe to commit.
 */
export function captureRecording(
  initial: World,
  index: Index,
  actions: readonly TimedAction[],
  durationTicks: number,
): Recording {
  const bare: Recording = {
    format: RECORDING_FORMAT,
    schema: RECORDING_SCHEMA,
    seed: initial.seed,
    tickMs: 100,
    durationTicks,
    actions: actions.map(({ t, a }) => ({ t, a })),
    checkpoints: [],
  };
  const runner = createRunner(initial, new RecordedSource(bare), index);
  runner.advance(durationTicks);
  return { ...bare, checkpoints: [...runner.checkpoints()] };
}
