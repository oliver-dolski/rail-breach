import { selectorMatches } from "../../core/attack/ops";
import type { PlaybookStep, TechniqueDef } from "../../core/attack/types";
import { isAction } from "../../core/sim/actions";
import type { Content } from "../types";
import { ContentError } from "../validate";
import type { Scenario } from "./types";

const isUint = (n: number): boolean => Number.isInteger(n) && n >= 0;

/**
 * Checks a scenario against the content and the technique catalogue it will run on, the
 * way validateContent checks the content: every problem is collected and thrown whole.
 * A scenario that names a node, a conduit or a technique that does not exist would
 * otherwise fail as a silent "never succeeds" in the middle of the show.
 *
 * The starting footholds get the same scrutiny as any other content: each must be a real
 * machine inside the network (never the Internet), listed once, and backed by exactly one
 * assume.breach action at the first tick; an assume.breach with no entry in the list, or
 * at any other tick, is refused, so the list and the recorded actions cannot disagree.
 */
export function validateScenario(
  scenario: Scenario,
  content: Content,
  techniques: readonly TechniqueDef[],
): void {
  const problems: string[] = [];
  const owner = `scenario "${scenario.id}"`;
  const nodes = new Map(content.nodes.map((n) => [n.id, n]));
  const conduits = new Set(content.conduits.map((c) => c.id));
  const links = new Set(content.links.map((l) => l.id));
  const known = new Set(techniques.flatMap((t) => [t.id, t.legacyId ?? t.id]));
  const byId = new Map<string, TechniqueDef>();
  for (const t of techniques) {
    byId.set(t.id, t);
    if (t.legacyId !== undefined) byId.set(t.legacyId, t);
  }
  /** The machines `technique` may be aimed at, as the engine's own selector decides. */
  const admitted = (technique: string) => {
    const def = byId.get(technique);
    return content.nodes.filter((n) => def !== undefined && selectorMatches(def.targets, n));
  };
  /** Why a playbook step can never find a machine, or undefined when it can. */
  const stepProblem = (step: PlaybookStep, n: number): string | undefined => {
    if (!known.has(step.technique)) return undefined;
    const fits = admitted(step.technique);
    const t = step.target;
    if (t === undefined) {
      return fits.length === 0
        ? `${owner} step ${n}: no machine is a valid target for ${step.technique}`
        : undefined;
    }
    if ("node" in t) {
      if (!nodes.has(t.node)) return undefined;
      return fits.some((f) => f.id === t.node)
        ? undefined
        : `${owner} step ${n}: "${t.node}" is not a valid target for ${step.technique}`;
    }
    const [kind, value] = "role" in t ? (["role", t.role] as const) : (["zone", t.zone] as const);
    const hit = fits.some((f) => (kind === "role" ? f.roles.includes(value) : f.zone === value));
    return hit
      ? undefined
      : `${owner} step ${n}: no machine with ${kind} "${value}" is a valid target for ${step.technique}`;
  };

  if (scenario.id === "") problems.push("a scenario has an empty id");
  if (scenario.title === "") problems.push(`${owner} has no title`);
  if (!isUint(scenario.seed)) problems.push(`${owner} seed must be a non-negative integer`);
  if (!isUint(scenario.startTick)) problems.push(`${owner} startTick must be an integer >= 0`);
  if (!isUint(scenario.durationTicks) || scenario.durationTicks <= scenario.startTick) {
    problems.push(`${owner} durationTicks must be an integer after startTick`);
  }

  const seenFootholds = new Set<string>();
  for (const id of scenario.initialFootholds) {
    const node = nodes.get(id);
    if (node === undefined)
      problems.push(`${owner} starts with a foothold on unknown node "${id}"`);
    else if (node.kind === "external") {
      problems.push(`${owner} cannot start with a foothold on the outside world ("${id}")`);
    }
    if (seenFootholds.has(id)) problems.push(`${owner} lists the foothold "${id}" twice`);
    seenFootholds.add(id);
  }

  const assumed = new Set<string>();
  let last = 0;
  for (const { t, a } of scenario.actions) {
    if (!Number.isInteger(t) || t < 1 || t > scenario.durationTicks) {
      problems.push(`${owner} has an action at tick ${t}, outside 1..durationTicks`);
    }
    if (t < last) problems.push(`${owner} actions are not in tick order at tick ${t}`);
    last = t;
    if (!isAction(a)) {
      problems.push(`${owner} has a malformed action at tick ${t}`);
      continue;
    }
    switch (a.type) {
      case "technique.launch":
        if (!known.has(a.technique)) problems.push(`${owner} launches unknown ${a.technique}`);
        if (!nodes.has(a.target))
          problems.push(`${owner} aims ${a.technique} at unknown "${a.target}"`);
        else if (known.has(a.technique) && !admitted(a.technique).some((n) => n.id === a.target)) {
          problems.push(`${owner} aims ${a.technique} at "${a.target}", which it cannot target`);
        }
        break;
      case "playbook.start":
        a.steps.forEach((step, i) => {
          if (!known.has(step.technique)) problems.push(`${owner} plays unknown ${step.technique}`);
          if (step.target !== undefined && "node" in step.target && !nodes.has(step.target.node)) {
            problems.push(`${owner} aims ${step.technique} at unknown "${step.target.node}"`);
          }
          const problem = stepProblem(step, i + 1);
          if (problem !== undefined) problems.push(problem);
        });
        break;
      case "assume.breach":
        if (t !== 1) problems.push(`${owner} assumes a breach at tick ${t}, not at the first tick`);
        if (!nodes.has(a.node)) problems.push(`${owner} assumes a breach of unknown "${a.node}"`);
        if (assumed.has(a.node)) problems.push(`${owner} assumes the breach of "${a.node}" twice`);
        assumed.add(a.node);
        break;
      case "defense.place":
        if ("conduit" in a.on ? !conduits.has(a.on.conduit) : !links.has(a.on.link)) {
          problems.push(`${owner} places a defense on something that is not in the content`);
        }
        break;
      case "noop":
      case "defense.remove":
        break;
      default:
        problems.push(`${owner} carries a "${a.type}" action, which a scenario does not use`);
    }
  }
  for (const id of assumed) {
    if (!seenFootholds.has(id)) {
      problems.push(`${owner} assumes a breach of "${id}" that initialFootholds does not list`);
    }
  }
  for (const id of seenFootholds) {
    if (!assumed.has(id)) {
      problems.push(`${owner} lists the foothold "${id}" but nothing assumes the breach`);
    }
  }

  if (problems.length > 0) throw new ContentError(problems);
}
