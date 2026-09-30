import type { Action } from "../sim/actions";
import type { Checkpoint, Recording } from "./recording";

/**
 * Where the runner gets its inputs. Live play and replay share one code path;
 * only the source differs.
 */
export interface ActionSource {
  /** Actions applied by the step that produces `tick`, in a deterministic order. */
  due(tick: number): readonly Action[];
  /** Hashes the runner must reproduce, when the source knows them (replay). */
  expectedCheckpoints?(): readonly Checkpoint[];
}

const NONE: readonly Action[] = [];

/** Reads a Recording. Pure: the same recording always yields the same answers. */
export class RecordedSource implements ActionSource {
  private readonly byTick = new Map<number, Action[]>();
  private readonly recorded: readonly Checkpoint[];

  constructor(recording: Recording) {
    // Array.prototype.sort is stable, so equal ticks keep their recorded order.
    const ordered = [...recording.actions].sort((x, y) => x.t - y.t);
    for (const { t, a } of ordered) {
      const bucket = this.byTick.get(t);
      if (bucket) bucket.push(a);
      else this.byTick.set(t, [a]);
    }
    this.recorded = recording.checkpoints;
  }

  due(tick: number): readonly Action[] {
    return this.byTick.get(tick) ?? NONE;
  }

  expectedCheckpoints(): readonly Checkpoint[] {
    return this.recorded;
  }
}
