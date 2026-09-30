import type { Content } from "./types";

export class ContentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid content:\n- ${problems.join("\n- ")}`);
    this.name = "ContentError";
  }
}

/**
 * Referential-integrity check run at load. Collects every problem and throws
 * one ContentError, so an authoring mistake is reported whole, not one id at a time.
 */
export function validateContent(content: Content): void {
  const problems: string[] = [];

  const idSet = (kind: string, items: readonly { id: string }[]): Set<string> => {
    const seen = new Set<string>();
    for (const { id } of items) {
      if (seen.has(id)) problems.push(`duplicate ${kind} id "${id}"`);
      seen.add(id);
    }
    return seen;
  };

  const zones = idSet("zone", content.zones);
  const nodes = idSet("node", content.nodes);
  idSet("link", content.links);
  const conduits = idSet("conduit", content.conduits);
  const interlockings = idSet("interlocking", content.interlockings);
  idSet("train", content.trains);

  const zoneOf = new Map<string, string>();
  for (const node of content.nodes) {
    if (!zones.has(node.zone))
      problems.push(`node "${node.id}" references unknown zone "${node.zone}"`);
    zoneOf.set(node.id, node.zone);
    if (node.controls !== undefined && !interlockings.has(node.controls)) {
      problems.push(`node "${node.id}" controls unknown interlocking "${node.controls}"`);
    }
    if ((node.kind === "interlocking" || node.kind === "object-controller") && !node.controls) {
      problems.push(`node "${node.id}" of kind ${node.kind} must declare controls`);
    }
    if (
      !Number.isInteger(node.hardeningPermille) ||
      node.hardeningPermille < 0 ||
      node.hardeningPermille > 1000
    ) {
      problems.push(`node "${node.id}" hardeningPermille must be an integer 0..1000`);
    }
  }

  const conduitZones = new Map<string, [string, string]>();
  for (const conduit of content.conduits) {
    for (const zone of [conduit.zoneA, conduit.zoneB]) {
      if (!zones.has(zone))
        problems.push(`conduit "${conduit.id}" references unknown zone "${zone}"`);
    }
    if (conduit.zoneA === conduit.zoneB)
      problems.push(`conduit "${conduit.id}" joins a zone to itself`);
    conduitZones.set(conduit.id, [conduit.zoneA, conduit.zoneB]);
  }

  const adjacency = new Map<string, string[]>();
  for (const id of nodes) adjacency.set(id, []);
  for (const link of content.links) {
    let endpointsOk = true;
    for (const end of [link.a, link.b]) {
      if (!nodes.has(end)) {
        problems.push(`link "${link.id}" references unknown node "${end}"`);
        endpointsOk = false;
      }
    }
    if (!Number.isInteger(link.latencyTicks) || link.latencyTicks < 1) {
      problems.push(`link "${link.id}" latencyTicks must be an integer >= 1`);
    }
    if (link.conduit !== undefined && !conduits.has(link.conduit)) {
      problems.push(`link "${link.id}" references unknown conduit "${link.conduit}"`);
    }
    if (!endpointsOk) continue;
    adjacency.get(link.a)?.push(link.b);
    adjacency.get(link.b)?.push(link.a);

    const za = zoneOf.get(link.a);
    const zb = zoneOf.get(link.b);
    const pair = link.conduit === undefined ? undefined : conduitZones.get(link.conduit);
    if (za !== undefined && zb !== undefined) {
      if (za === zb) {
        if (link.conduit !== undefined) {
          problems.push(`link "${link.id}" stays inside zone "${za}" but names a conduit`);
        }
      } else if (link.conduit === undefined) {
        problems.push(`link "${link.id}" crosses zones "${za}" and "${zb}" without a conduit`);
      } else if (pair !== undefined) {
        const joins = (pair[0] === za && pair[1] === zb) || (pair[0] === zb && pair[1] === za);
        if (!joins) {
          problems.push(
            `link "${link.id}" crosses "${za}" and "${zb}" but conduit "${link.conduit}" joins "${pair[0]}" and "${pair[1]}"`,
          );
        }
      }
    }
  }

  for (const train of content.trains) {
    if (!Number.isInteger(train.startPosDm)) {
      problems.push(`train "${train.id}" startPosDm must be an integer`);
    }
  }

  const externals = content.nodes.filter((n) => n.kind === "external").map((n) => n.id);
  if (externals.length === 0) {
    problems.push("no external pseudo-node: the attacker has no origin");
  } else {
    const reached = new Set<string>(externals);
    const queue = [...externals];
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head];
      if (at === undefined) continue;
      for (const next of adjacency.get(at) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    for (const id of nodes) {
      if (!reached.has(id)) problems.push(`node "${id}" is unreachable from the external node`);
    }
  }

  if (problems.length > 0) throw new ContentError(problems);
}
