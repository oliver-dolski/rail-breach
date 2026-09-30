import type { NodeDef } from "../../content/types";
import { MAX_PLAYBOOK_STEPS, PLAYBOOK_GAP_TICKS } from "../sim/constants";
import type { SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import type { World } from "../sim/world";
import { evaluate, launchTechnique, selectorMatches } from "./ops";
import type { PlaybookStep, StepTarget, TechniqueDef } from "./types";

/**
 * Playbooks: an ordered list of resolved steps run one after the other. The core never
 * sees text; a step names a technique and at most a node, a role or a zone of the
 * content. Launching goes through the same launchTechnique a single action uses, so a
 * playbook can do nothing a sequence of technique.launch actions could not.
 */

const KEYS = ["technique", "target"];
const TARGET_KEYS = ["node", "role", "zone"];

/** Runtime guard for one step of a playbook: exact keys, a string technique, a well-formed target. */
export function isPlaybookStep(value: unknown): value is PlaybookStep {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Object.keys(v).every((key) => KEYS.includes(key))) return false;
  if (typeof v.technique !== "string") return false;
  if (v.target === undefined) return true;
  const t = v.target;
  if (typeof t !== "object" || t === null || Array.isArray(t)) return false;
  const keys = Object.keys(t);
  return (
    keys.length === 1 &&
    TARGET_KEYS.includes(keys[0] ?? "") &&
    typeof (t as Record<string, unknown>)[keys[0] ?? ""] === "string"
  );
}

/** Runtime guard for a whole playbook: one to MAX_PLAYBOOK_STEPS well-formed steps. */
export function isPlaybookSteps(value: unknown): value is PlaybookStep[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_PLAYBOOK_STEPS &&
    value.every(isPlaybookStep)
  );
}

function inTarget(target: StepTarget, def: NodeDef): boolean {
  if ("node" in target) return def.id === target.node;
  if ("role" in target) return def.roles.includes(target.role);
  return def.zone === target.zone;
}

/**
 * The node a step is aimed at, resolved against the world as it is now: the first node,
 * in id order, that fits the target and that the technique may be launched at, or else
 * the first that fits (so the refusal names what is missing). A step with no target
 * takes any node the technique admits. A named node is taken as given.
 */
export function resolveStepTarget(
  world: World,
  index: Index,
  def: TechniqueDef,
  target: StepTarget | undefined,
): string | undefined {
  if (target !== undefined && "node" in target) return target.node;
  const fits: string[] = [];
  for (const state of world.nodes) {
    const nodeDef = index.nodeDefs.get(state.id);
    if (nodeDef === undefined || !selectorMatches(def.targets, nodeDef)) continue;
    if (target !== undefined && !inTarget(target, nodeDef)) continue;
    fits.push(state.id);
  }
  const ready = fits.find((id) => evaluate(world, index, def, id).reasons.length === 0);
  return ready ?? fits[0];
}

function launchStep(
  world: World,
  index: Index,
  step: PlaybookStep,
  tick: number,
  events: SimEvent[],
): void {
  const def = index.techniques.get(step.technique);
  if (def === undefined) {
    events.push({
      k: "technique.rejected",
      tick,
      technique: step.technique,
      target: "",
      reasons: ["unknown technique"],
    });
    return;
  }
  const node = resolveStepTarget(world, index, def, step.target);
  if (node === undefined) {
    events.push({
      k: "technique.rejected",
      tick,
      technique: def.id,
      target: "",
      reasons: ["no node fits the target"],
    });
    return;
  }
  launchTechnique(world, { technique: step.technique, target: node }, tick, events, index);
}

/**
 * Launches the next step of every playbook whose previous operation has ended. Runs
 * after the attack ops in the same tick, so an operation that ended this tick frees the
 * playbook, which then waits PLAYBOOK_GAP_TICKS before the next step.
 */
export function stepPlaybooks(world: World, index: Index, events: SimEvent[]): void {
  if (world.playbooks.length === 0) return;
  const tick = world.tick;
  const kept = [];
  for (const pb of world.playbooks) {
    if (pb.waitOp >= 0) {
      if (world.ops.some((op) => op.id === pb.waitOp)) {
        kept.push(pb);
        continue;
      }
      pb.waitOp = -1;
      pb.readyAt = tick + PLAYBOOK_GAP_TICKS;
    }
    if (tick >= pb.readyAt) {
      const step = pb.steps[pb.next];
      pb.next += 1;
      if (step !== undefined) {
        const seq = world.opSeq;
        launchStep(world, index, step, tick, events);
        if (world.ops.some((op) => op.id === seq)) pb.waitOp = seq;
        else pb.readyAt = tick + PLAYBOOK_GAP_TICKS;
      }
    }
    if (pb.next < pb.steps.length) kept.push(pb);
  }
  world.playbooks = kept;
}
