import { network } from "../content/network";
import { phishingDispatcher, type Scenario } from "../content/scenarios";
import { validateScenario } from "../content/scenarios/validate";
import { techniques } from "../content/techniques";
import type { Content } from "../content/types";
import { validateContent, validateTechniques } from "../content/validate";
import { InvariantViolation } from "../core/rail/invariants";
import { assertRecording, type Recording, type TimedAction } from "../core/replay/recording";
import { createRunner, ReplayMismatchError, type Runner } from "../core/replay/runner";
import { type ActionSource, RecordedSource } from "../core/replay/source";
import { type Action, isAction } from "../core/sim/actions";
import type { SimEvent } from "../core/sim/events";
import { buildIndex, type Index } from "../core/sim/model";
import { createWorld, type World } from "../core/sim/world";
import { recordingFor } from "./catalog";

/** Ticks the final picture stays up before attract mode starts over (10 seconds). */
export const HOLD_TICKS = 100;

export interface SessionStatus {
  /** False once the core reported a broken safety invariant. Never true again after that. */
  held: boolean;
  violations: readonly string[];
  /** Ticks for which the core asserted the invariant, including the quiet stretch before the start. */
  checkedTicks: number;
  /** Set when the recording no longer matches the engine; the session stops advancing. */
  failure: string | undefined;
}

export interface AttractSession {
  readonly content: Content;
  readonly index: Index;
  readonly scenario: Scenario;
  readonly recording: Recording;
  /** The current world. Read-only: step() replaces it every tick. */
  world(): World;
  /** The world one tick earlier, for interpolation; undefined right after a start. */
  previous(): World | undefined;
  /** Runs `ticks` ticks one at a time, asserting the safety invariant on every one. */
  advance(ticks: number): void;
  /** Returns and clears the events emitted since the last call. */
  drainEvents(): SimEvent[];
  status(): SessionStatus;
  /**
   * Hands the engine a live action (a defense, in practice) for the next tick. The first
   * one forks the show from the current world: the rest of the recording still plays,
   * with the action added, but the run is no longer the recorded one and its hash
   * checkpoints are no longer checked. The safety invariant still is, every tick.
   * Returns why the action was not taken (not a well-formed action, or the session has
   * stopped), or undefined when it was queued; the caller shows that to the viewer.
   */
  dispatch(action: Action): string | undefined;
  /** True once a live action has forked the show; false again after a restart. */
  live(): boolean;
  /**
   * Latches the safety indicator as breached with the core's own text, for a violation found
   * outside the live loop (a comparison run). Never goes back to held, like the loop's own halt.
   */
  reportViolation(violations: readonly string[]): void;
  /** Starts the show over from its beginning, dropping every live action. */
  reset(): void;
  /** The world the show starts from, after the quiet stretch: what a comparison re-runs from. */
  startWorld(): World;
  /**
   * Every action dispatched live since the show started (or was last started over), stamped
   * with the tick it was applied on, in order. The recorded actions are not among them.
   */
  liveActions(): readonly TimedAction[];
  /** Ticks since the start of the show (negative never happens). */
  elapsedTicks(): number;
  /** Counts how many times the show has started over; the UI clears its state on change. */
  generation(): number;
}

export interface SessionOptions {
  scenario?: Scenario;
  recording?: unknown;
  content?: Content;
}

/**
 * The attract-mode session: the committed recording replayed through the real
 * engine, verified against its hash checkpoints. The quiet stretch before the
 * scenario's start tick is run once up front and kept as a snapshot, so the show
 * begins on a busy railway and starting over is instant.
 */
export function createAttractSession(options: SessionOptions = {}): AttractSession {
  const scenario = options.scenario ?? phishingDispatcher;
  const content = options.content ?? network;
  const raw: unknown = options.recording ?? recordingFor(scenario.id);
  assertRecording(raw);
  const recording: Recording = raw;

  // Authoring mistakes fail here, whole and named, not as a silent never-succeeds later.
  validateContent(content);
  validateTechniques(techniques, content);
  validateScenario(scenario, content, techniques);

  // The safety check stays on: every tick of the run is asserted, and a breach throws.
  const index = buildIndex(content, { techniques, checkInvariants: true });
  const source = new RecordedSource(recording);

  const warm = createRunner(createWorld(content, recording.seed), source, index);
  warm.advance(scenario.startTick);
  const snapshot = warm.view();

  // The quiet stretch is not narrated, but an assumed breach is where the story begins: the
  // viewer is told of it at the start of the show, every time the show starts.
  const opening = (): SimEvent[] =>
    scenario.initialFootholds.map((node) => ({
      k: "breach.assumed",
      tick: scenario.startTick,
      node,
    }));

  let runner: Runner = createRunner(snapshot, source, index);
  let previous: World | undefined;
  let pending: SimEvent[] = opening();
  let generation = 0;
  let checkedTicks = scenario.startTick;
  let held = true;
  let violations: readonly string[] = [];
  let failure: string | undefined;

  let queue = new LiveQueue();
  let forked = false;

  const restart = (): void => {
    runner = createRunner(snapshot, source, index);
    queue = new LiveQueue();
    forked = false;
    previous = undefined;
    pending = opening();
    generation++;
  };

  return {
    content,
    index,
    scenario,
    recording,
    world: () => runner.view(),
    previous: () => previous,
    advance(ticks) {
      for (let i = 0; i < ticks; i++) {
        if (failure !== undefined || !held) return;
        if (runner.view().tick >= recording.durationTicks + HOLD_TICKS) restart();
        previous = runner.view();
        try {
          runner.advance(1);
          checkedTicks++;
        } catch (error) {
          if (error instanceof InvariantViolation) {
            held = false;
            violations = error.violations;
          } else if (error instanceof ReplayMismatchError) {
            failure = error.message;
          } else {
            throw error;
          }
          // A replay mismatch is raised after the tick's events were recorded; keep them.
          for (const event of runner.drainEvents()) pending.push(event);
          return;
        }
        for (const event of runner.drainEvents()) pending.push(event);
      }
    },
    drainEvents() {
      const out = pending;
      pending = [];
      return out;
    },
    dispatch(action) {
      // The same exact-key guard a recording passes: nothing unchecked reaches the engine.
      if (!isAction(action)) return "That action is not well formed, so it was not applied.";
      if (failure !== undefined || !held)
        return "The session has stopped, so nothing more can be applied.";
      if (!forked) {
        // The recorded actions still due keep coming; nothing is verified against them any more.
        const merged: ActionSource = {
          due: (tick) => [...source.due(tick), ...queue.due(tick)],
        };
        runner = createRunner(runner.view(), merged, index);
        forked = true;
      }
      queue.enqueue(stampAction(runner.view(), action));
      return undefined;
    },
    startWorld: () => snapshot,
    liveActions: () => queue.all(),
    live: () => forked,
    reportViolation(list) {
      if (!held) return;
      held = false;
      violations = list;
    },
    reset: restart,
    status: () => ({ held, violations, checkedTicks, failure }),
    elapsedTicks: () => Math.max(0, runner.view().tick - scenario.startTick),
    generation: () => generation,
  };
}

/** The tick a command dispatched now is applied on: the next one. */
export function stampAction(world: World, action: Action): TimedAction {
  return { t: world.tick + 1, a: action };
}

/**
 * Where live commands will be queued once someone can issue them. Attract mode
 * does not use it; it exists so live play and replay share one runner path.
 */
export class LiveQueue implements ActionSource {
  private readonly byTick = new Map<number, Action[]>();
  private readonly list: TimedAction[] = [];

  enqueue(stamped: TimedAction): void {
    this.list.push(stamped);
    const bucket = this.byTick.get(stamped.t);
    if (bucket) bucket.push(stamped.a);
    else this.byTick.set(stamped.t, [stamped.a]);
  }

  due(tick: number): readonly Action[] {
    return this.byTick.get(tick) ?? [];
  }

  /** Everything queued so far, in the order it was dispatched. */
  all(): readonly TimedAction[] {
    return this.list;
  }
}
