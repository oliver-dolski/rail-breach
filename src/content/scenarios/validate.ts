import type { TechniqueDef } from "../../core/attack/types";
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
        break;
      case "playbook.start":
        for (const step of a.steps) {
          if (!known.has(step.technique)) problems.push(`${owner} plays unknown ${step.technique}`);
          if (step.target !== undefined && "node" in step.target && !nodes.has(step.target.node)) {
            problems.push(`${owner} aims ${step.technique} at unknown "${step.target.node}"`);
          }
        }
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
