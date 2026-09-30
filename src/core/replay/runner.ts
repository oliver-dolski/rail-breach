import { stateHash } from "../hash";
import { CHECKPOINT_INTERVAL_TICKS } from "../sim/constants";
import type { SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import { step } from "../sim/step";
import type { World } from "../sim/world";
import type { Checkpoint } from "./recording";
import type { ActionSource } from "./source";

export class ReplayMismatchError extends Error {
  constructor(
    readonly tick: number,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`replay diverged at tick ${tick}: expected ${expected}, got ${actual}`);
    this.name = "ReplayMismatchError";
  }
}

export interface Runner {
  /** Advances n ticks. Chunking never changes the result. */
  advance(n: number): void;
  /** The current world. Treat as read-only; step() replaces it every tick. */
  view(): World;
  /** Hashes taken so far, one every CHECKPOINT_INTERVAL_TICKS. */
  checkpoints(): readonly Checkpoint[];
  /** Returns and clears the events emitted since the last drain. */
  drainEvents(): SimEvent[];
}

/**
 * Drives step() over an ActionSource. Every CHECKPOINT_INTERVAL_TICKS it hashes
 * the world and, when the source knows the recorded hash for that tick,
 * compares and throws ReplayMismatchError on divergence.
 */
export function createRunner(initial: World, source: ActionSource, index?: Index): Runner {
  let world = initial;
  let pending: SimEvent[] = [];
  const taken: Checkpoint[] = [];
  const expected = new Map<number, string>();
  for (const c of source.expectedCheckpoints?.() ?? []) expected.set(c.t, c.h);

  return {
    advance(n) {
      if (!Number.isInteger(n) || n < 0)
        throw new Error("advance: n must be a non-negative integer");
      for (let i = 0; i < n; i++) {
        const result = step(world, source.due(world.tick + 1), index);
        world = result.world;
        for (const event of result.events) pending.push(event);
        if (world.tick % CHECKPOINT_INTERVAL_TICKS === 0) {
          const h = stateHash(world);
          taken.push({ t: world.tick, h });
          const want = expected.get(world.tick);
          if (want !== undefined && want !== h) throw new ReplayMismatchError(world.tick, want, h);
        }
      }
    },
    view: () => world,
    checkpoints: () => taken,
    drainEvents() {
      const out = pending;
      pending = [];
      return out;
    },
  };
}
