import type { TechniqueDef } from "../core/attack/types";
import { buildNetIndex, reachableFrom } from "../core/net/graph";
import { emergencyBrakeDistance } from "../core/rail/kinematics";
import { MAX_SPEED_DM_PER_TICK, TRAIN_LENGTH_DM } from "../core/sim/constants";
import type { Content, NodeDef } from "./types";

export class ContentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid content:\n- ${problems.join("\n- ")}`);
    this.name = "ContentError";
  }
}

function idSet(kind: string, items: readonly { id: string }[], problems: string[]): Set<string> {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) problems.push(`duplicate ${kind} id "${id}"`);
    seen.add(id);
  }
  return seen;
}

const isCount = (n: number, min: number): boolean => Number.isInteger(n) && n >= min;

const isPermille = (n: number | undefined): boolean =>
  n !== undefined && Number.isInteger(n) && n >= 0 && n <= 1000;

/**
 * Referential-integrity check run at load. Collects every problem and throws
 * one ContentError, so an authoring mistake is reported whole, not one id at a time.
 */
export function validateContent(content: Content): void {
  const problems: string[] = [];

  const zones = idSet("zone", content.zones, problems);
  const nodes = idSet("node", content.nodes, problems);
  idSet("link", content.links, problems);
  const conduits = idSet("conduit", content.conduits, problems);
  const interlockings = idSet("interlocking", content.interlockings, problems);

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
    if (node.awarenessPermille !== undefined && !isPermille(node.awarenessPermille)) {
      problems.push(`node "${node.id}" awarenessPermille must be an integer 0..1000`);
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

  const externals = content.nodes.filter((n) => n.kind === "external").map((n) => n.id);
  if (externals.length === 0) {
    problems.push("no external pseudo-node: the attacker has no origin");
  } else {
    const reached = reachableFrom(buildNetIndex(content), externals);
    for (const id of nodes) {
      if (!reached.has(id)) problems.push(`node "${id}" is unreachable from the external node`);
    }
  }

  validateTracks(content, interlockings, problems);

  if (problems.length > 0) throw new ContentError(problems);
}

/**
 * Checks the technique catalogue against the content it runs on. The engine
 * trusts these numbers: a duration with max below min turns the jitter into NaN,
 * a chance above 1000 permille is silently certain, and a legacy id that matches
 * another technique would overwrite it in the lookup table. Collects every
 * problem and throws one ContentError.
 */
export function validateTechniques(defs: readonly TechniqueDef[], content: Content): void {
  const problems: string[] = [];
  const keys = new Map<string, string>();
  const claim = (key: string, owner: string, what: string): void => {
    const other = keys.get(key);
    if (other !== undefined) {
      problems.push(`${what} "${key}" of ${owner} is already taken by ${other}`);
    } else {
      keys.set(key, owner);
    }
  };
  const tags = new Set(content.nodes.flatMap((n) => n.tags as readonly string[]));

  for (const def of defs) {
    const owner = `technique "${def.id}"`;
    if (def.id === "") problems.push("a technique has an empty id");
    claim(def.id, owner, "id");
    if (def.legacyId !== undefined) claim(def.legacyId, owner, "legacy id");

    const [min, max] = def.durationTicks;
    if (!isCount(min, 1) || !isCount(max, 1) || max < min) {
      problems.push(`${owner} durationTicks must be integers with 1 <= min <= max`);
    }
    if (!isPermille(def.successPermille)) {
      problems.push(`${owner} successPermille must be an integer 0..1000`);
    }
    for (const effect of def.effects) {
      if (effect.k === "discover" && !isCount(effect.hops, 0)) {
        problems.push(`${owner} discover hops must be an integer >= 0`);
      }
      if (effect.k === "foothold" && effect.priv !== 1 && effect.priv !== 2) {
        problems.push(`${owner} foothold privilege must be 1 or 2`);
      }
      if ((effect.k === "blockCommands" || effect.k === "denyControl") && effect.onTag) {
        if (!tags.has(effect.onTag)) {
          problems.push(`${owner} ${effect.k} names tag "${effect.onTag}" that no node carries`);
        }
      }
    }
  }

  if (problems.length > 0) throw new ContentError(problems);
}

function validateTracks(content: Content, interlockings: Set<string>, problems: string[]): void {
  const t = content.tracks;
  const nodeById = new Map<string, NodeDef>(content.nodes.map((n) => [n.id, n]));
  const vmax = t.vmaxDmPerTick;
  const vmaxOk = isCount(vmax, 1) && vmax <= MAX_SPEED_DM_PER_TICK;
  if (!vmaxOk) problems.push(`vmaxDmPerTick must be an integer 1..${MAX_SPEED_DM_PER_TICK}`);
  const emergency = vmaxOk ? emergencyBrakeDistance(vmax) : 0;

  const blockIds = idSet("block", t.blocks, problems);
  idSet("point", t.points, problems);
  idSet("signal", t.signals, problems);
  idSet("route", t.routes, problems);
  idSet("service", t.services, problems);

  const checkController = (owner: string, id: string, expectedIl?: string): void => {
    const node = nodeById.get(id);
    if (node === undefined) {
      problems.push(`${owner} names unknown controller "${id}"`);
    } else if (node.kind !== "object-controller") {
      problems.push(`${owner} controller "${id}" is not an object controller`);
    } else if (expectedIl !== undefined && node.controls !== expectedIl) {
      problems.push(
        `${owner} controller "${id}" belongs to "${node.controls}", not "${expectedIl}"`,
      );
    }
  };

  const blocks = new Map(t.blocks.map((b) => [b.id, b]));
  const sectionShape = new Map<string, { lengthDm: number; controller: string }>();
  for (const block of t.blocks) {
    if (!isCount(block.lengthDm, 1)) {
      problems.push(`block "${block.id}" lengthDm must be a positive integer`);
    }
    if (block.section === "") problems.push(`block "${block.id}" has no section`);
    for (const next of block.next) {
      if (!blockIds.has(next)) {
        problems.push(`block "${block.id}" continues into unknown block "${next}"`);
      }
    }
    checkController(`block "${block.id}"`, block.controller);
    const seen = sectionShape.get(block.section);
    if (seen === undefined) {
      sectionShape.set(block.section, { lengthDm: block.lengthDm, controller: block.controller });
    } else if (seen.lengthDm !== block.lengthDm || seen.controller !== block.controller) {
      problems.push(
        `blocks sharing section "${block.section}" must have one length and one controller`,
      );
    }
  }

  for (const signal of t.signals) {
    const owner = `signal "${signal.id}"`;
    const block = blocks.get(signal.block);
    if (block === undefined) {
      problems.push(`${owner} stands on unknown block "${signal.block}"`);
    } else {
      if (signal.atDm !== block.lengthDm) {
        problems.push(`${owner} must stand at the far end of block "${block.id}"`);
      }
      for (const next of block.next) {
        const after = blocks.get(next);
        if (after !== undefined && after.lengthDm < signal.overlapDm) {
          problems.push(
            `${owner} overlap of ${signal.overlapDm} dm does not fit in block "${next}"`,
          );
        }
      }
    }
    if (!interlockings.has(signal.interlocking)) {
      problems.push(`${owner} belongs to unknown interlocking "${signal.interlocking}"`);
    }
    checkController(owner, signal.controller, signal.interlocking);
    if (!Number.isInteger(signal.overlapDm) || signal.overlapDm < emergency) {
      problems.push(
        `${owner} overlap of ${signal.overlapDm} dm is shorter than the emergency braking distance of ${emergency} dm at vmax`,
      );
    }
  }

  const sectionIds = new Set(t.blocks.map((b) => b.section));
  for (const point of t.points) {
    const owner = `point "${point.id}"`;
    if (!interlockings.has(point.interlocking)) {
      problems.push(`${owner} belongs to unknown interlocking "${point.interlocking}"`);
    }
    checkController(owner, point.controller, point.interlocking);
    if (!isCount(point.movingTicks, 1)) {
      problems.push(`${owner} movingTicks must be an integer >= 1`);
    }
    for (const id of [point.toe, point.normal, point.reverse]) {
      if (!blockIds.has(id)) problems.push(`${owner} names unknown block "${id}"`);
    }
    if (point.normal === point.reverse) problems.push(`${owner} has the same block on both legs`);
    for (const id of point.zone) {
      if (!sectionIds.has(id)) problems.push(`${owner} zone names unknown section "${id}"`);
    }
  }

  const points = new Map(t.points.map((p) => [p.id, p]));
  const signals = new Map(t.signals.map((s) => [s.id, s]));
  const endSignalOf = (blockId: string) =>
    t.signals.find((s) => s.block === blockId && blocks.get(blockId)?.lengthDm === s.atDm);
  const entryKeys = new Set<string>();

  for (const route of t.routes) {
    const owner = `route "${route.id}"`;
    const entry = signals.get(route.entrySignal);
    if (entry === undefined) {
      problems.push(`${owner} names unknown entry signal "${route.entrySignal}"`);
    } else if (entry.interlocking !== route.interlocking) {
      problems.push(
        `${owner} belongs to "${route.interlocking}" but its entry signal to "${entry.interlocking}"`,
      );
    }
    if (!interlockings.has(route.interlocking)) {
      problems.push(`${owner} belongs to unknown interlocking "${route.interlocking}"`);
    }
    const firstBlock = route.blocks[0];
    if (firstBlock === undefined) {
      problems.push(`${owner} has no blocks`);
      continue;
    }
    for (const id of [...route.blocks, ...route.overlap]) {
      if (!blockIds.has(id)) problems.push(`${owner} names unknown block "${id}"`);
    }
    const key = `${route.entrySignal}>${firstBlock}`;
    if (entryKeys.has(key)) {
      problems.push(`${owner} duplicates another route from the same signal into the same block`);
    }
    entryKeys.add(key);

    const entryBlock = entry === undefined ? undefined : blocks.get(entry.block);
    if (entryBlock !== undefined && !entryBlock.next.includes(firstBlock)) {
      problems.push(`${owner} does not continue from the block of its entry signal`);
    }
    route.blocks.forEach((id, i) => {
      const after = route.blocks[i + 1];
      if (after !== undefined && !blocks.get(id)?.next.includes(after)) {
        problems.push(`${owner} blocks "${id}" and "${after}" are not connected`);
      }
    });
    for (const want of route.points) {
      const point = points.get(want.point);
      if (point === undefined) {
        problems.push(`${owner} names unknown point "${want.point}"`);
        continue;
      }
      const leg = want.pos === "normal" ? point.normal : point.reverse;
      if (!route.blocks.includes(leg) && leg !== entry?.block) {
        problems.push(`${owner} sets point "${want.point}" ${want.pos} but never uses that leg`);
      }
    }

    const last = route.blocks[route.blocks.length - 1] ?? firstBlock;
    const lastBlock = blocks.get(last);
    if (lastBlock !== undefined) {
      if (endSignalOf(last) === undefined) {
        if (lastBlock.next.length > 0) {
          problems.push(`${owner} ends in "${last}" without a signal though the line continues`);
        }
        if (route.overlap.length > 0) {
          problems.push(`${owner} has an overlap but ends at the end of the line`);
        }
      } else {
        for (const next of lastBlock.next) {
          if (!route.overlap.includes(next)) {
            problems.push(`${owner} overlap does not cover the continuation into "${next}"`);
          }
        }
        for (const id of route.overlap) {
          if (!lastBlock.next.includes(id)) {
            problems.push(`${owner} overlap block "${id}" is not beyond its end signal`);
          }
        }
      }
    }
  }

  for (const service of t.services) {
    const owner = `service "${service.id}"`;
    if (service.path.length < 2) problems.push(`${owner} needs a path of at least two blocks`);
    if (!isCount(service.firstTick, 1)) problems.push(`${owner} firstTick must be an integer >= 1`);
    if (!isCount(service.headwayTicks, 1)) {
      problems.push(`${owner} headwayTicks must be an integer >= 1`);
    }
    if (!isCount(service.count, 1)) problems.push(`${owner} count must be an integer >= 1`);
    const unknown = service.path.filter((id) => !blockIds.has(id));
    for (const id of unknown) problems.push(`${owner} path names unknown block "${id}"`);
    if (unknown.length > 0) continue;

    if ((blocks.get(service.path[0] ?? "")?.lengthDm ?? 0) < TRAIN_LENGTH_DM) {
      problems.push(`${owner} starts in a block shorter than a train`);
    }
    service.path.forEach((id, i) => {
      const after = service.path[i + 1];
      if (after === undefined) return;
      if (!blocks.get(id)?.next.includes(after)) {
        problems.push(`${owner} path blocks "${id}" and "${after}" are not connected`);
        return;
      }
      const signal = endSignalOf(id);
      if (signal === undefined) return;
      const route = t.routes.find((r) => r.entrySignal === signal.id && r.blocks[0] === after);
      if (route === undefined) {
        problems.push(
          `${owner} passes signal "${signal.id}" into "${after}" but no route allows it`,
        );
        return;
      }
      route.blocks.forEach((rb, j) => {
        if (service.path[i + 1 + j] !== rb) {
          problems.push(`${owner} leaves route "${route.id}" before its end`);
        }
      });
    });
    let from = 0;
    for (const stop of service.stops) {
      const at = service.path.indexOf(stop.block, from);
      if (at < 0) {
        problems.push(`${owner} stops at "${stop.block}" which is not on its path in order`);
      } else {
        from = at + 1;
      }
      if (!isCount(stop.dwellTicks, 0)) {
        problems.push(`${owner} dwell at "${stop.block}" must be an integer >= 0`);
      }
    }
  }
}
