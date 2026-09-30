import type { LinkDef, Protocol } from "../../content/types";
import type { RejectReason, SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import type { World } from "../sim/world";

/**
 * Network defenses of the IEC 62443 kind: what a defender can put on a conduit or a
 * single link. They are data in World.defenses and they do exactly two things: a
 * firewall and a diode narrow what may cross a link (linkAllows, consulted for
 * every path plan and every hop), and an IDS sensor raises the chance that a hop
 * is noticed (core/detect/ids). They never grant the attacker anything and never
 * touch a node, a lock, an aspect, a point or a train.
 */

export type DefenseKind = "firewall" | "diode" | "ids";

/** "a-to-b" runs from the first end to the second: of a link, or of a conduit's zones. */
export type DiodeDirection = "a-to-b" | "b-to-a";

/** Where a placement goes: every link of one conduit, or one link. */
export type DefenseTarget = { conduit: string } | { link: string };

/** What a placement may configure. A firewall takes `allow`, a diode `direction`. */
export interface DefenseConfig {
  direction?: DiodeDirection;
  allow?: string[];
}

/**
 * One defense on one link. A placement on a conduit creates one instance per member
 * link, all sharing `id`, so removing the placement removes them together.
 */
export interface DefenseInstance {
  id: string;
  kind: DefenseKind;
  link: string;
  /** The conduit the placement named, or "" when it named the link. */
  conduit: string;
  /** Diodes only, relative to the link's own ends (a to b); "" otherwise. */
  direction: "" | DiodeDirection;
  /** Firewalls only: the protocols it lets through. Sorted; empty lets nothing through. */
  allow: string[];
  placedAt: number;
  /** The first tick the defense has any effect: placing it takes time. */
  activeFrom: number;
}

/** Hard cap on live defense instances, so a hostile recording cannot grow the world without end. */
export const MAX_DEFENSES = 200;
const MAX_ALLOW_ENTRIES = 32;
const MAX_PROTOCOL_LENGTH = 64;

export const DEFENSE_KINDS: readonly DefenseKind[] = ["firewall", "diode", "ids"];

export function isDefenseKind(value: unknown): value is DefenseKind {
  return typeof value === "string" && (DEFENSE_KINDS as readonly string[]).includes(value);
}

const isDirection = (value: unknown): value is DiodeDirection =>
  value === "a-to-b" || value === "b-to-a";

/** Exactly one key, `conduit` or `link`, holding a string. */
export function isDefenseTarget(value: unknown): value is DefenseTarget {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  const [key] = keys;
  return keys.length === 1 && (key === "conduit" || key === "link") && typeof v[key] === "string";
}

/** Only `direction` and `allow`, each of the right shape and size. */
export function isDefenseConfig(value: unknown): value is DefenseConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Object.keys(v).every((key) => key === "direction" || key === "allow")) return false;
  if (v.direction !== undefined && !isDirection(v.direction)) return false;
  if (v.allow !== undefined) {
    if (!Array.isArray(v.allow) || v.allow.length > MAX_ALLOW_ENTRIES) return false;
    if (!v.allow.every((p) => typeof p === "string" && p.length <= MAX_PROTOCOL_LENGTH)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether traffic of `protocol` may cross `link` from `from` to `to` at `tick`: the
 * link must carry the protocol and every defense on it that is already in force
 * must agree. A technique that does not travel (null protocol) crosses nothing.
 */
export function linkAllows(
  link: LinkDef,
  protocol: Protocol | null,
  from: string,
  to: string,
  world: Pick<World, "defenses">,
  tick: number,
): boolean {
  if (protocol === null) return true;
  if (!link.protocols.includes(protocol)) return false;
  for (const defense of world.defenses) {
    if (defense.link !== link.id || tick < defense.activeFrom) continue;
    if (defense.kind === "firewall" && !defense.allow.includes(protocol)) return false;
    if (defense.kind === "diode") {
      const forward = from === link.a && to === link.b;
      const backward = from === link.b && to === link.a;
      if (!(defense.direction === "a-to-b" ? forward : backward)) return false;
    }
  }
  return true;
}

type PlaceAction = {
  kind: DefenseKind;
  on: DefenseTarget;
  config?: DefenseConfig;
};

/** A placement is well-formed when its config belongs to its kind. */
function configFits(kind: DefenseKind, config: DefenseConfig): boolean {
  if (kind === "firewall") return config.direction === undefined;
  if (kind === "diode") return config.allow === undefined;
  return config.direction === undefined && config.allow === undefined;
}

/** The links a target names, in id order, with the conduit id ("" for a single link). */
function resolveTarget(
  index: Index,
  on: DefenseTarget,
): { links: LinkDef[]; conduit: string } | undefined {
  if ("conduit" in on) {
    const links = index.net.conduitLinks.get(on.conduit);
    return links === undefined || links.length === 0 ? undefined : { links, conduit: on.conduit };
  }
  const link = index.net.linkById.get(on.link);
  return link === undefined ? undefined : { links: [link], conduit: "" };
}

/**
 * Puts a defense on a conduit or a link. It takes DEFENSE_PLACEMENT_LATENCY_TICKS
 * to come into force. An unknown target, a config that does not fit the kind, a
 * placement that changes nothing or one past the cap is refused with an event, and
 * the world is left as it was.
 */
export function placeDefense(
  world: World,
  index: Index,
  action: PlaceAction,
  tick: number,
  latencyTicks: number,
  events: SimEvent[],
): void {
  const reject = (reason: RejectReason): void => {
    events.push({ k: "action.rejected", tick, reason });
  };
  const config = action.config ?? {};
  if (!configFits(action.kind, config)) {
    reject("invalid-defense");
    return;
  }
  const target = resolveTarget(index, action.on);
  if (target === undefined) {
    reject("unknown-target");
    return;
  }

  const conduit = index.conduits.get(target.conduit);
  const allow = action.kind === "firewall" ? [...new Set(config.allow ?? [])].sort() : [];
  const fresh: DefenseInstance[] = [];
  const id = `d${world.defenseSeq + 1}`;
  for (const link of target.links) {
    let direction: "" | DiodeDirection = "";
    if (action.kind === "diode") {
      // On a conduit the direction is between its zones; a link's own ends may run either way.
      const requested = config.direction ?? "a-to-b";
      const flipped = conduit !== undefined && index.nodeDefs.get(link.a)?.zone !== conduit.zoneA;
      direction = flipped ? (requested === "a-to-b" ? "b-to-a" : "a-to-b") : requested;
    }
    const same = world.defenses.some(
      (d) =>
        d.link === link.id &&
        d.kind === action.kind &&
        d.direction === direction &&
        d.allow.join(",") === allow.join(","),
    );
    if (same) continue;
    fresh.push({
      id,
      kind: action.kind,
      link: link.id,
      conduit: target.conduit,
      direction,
      allow,
      placedAt: tick,
      activeFrom: tick + latencyTicks,
    });
  }
  if (fresh.length === 0) {
    reject("already-placed");
    return;
  }
  if (world.defenses.length + fresh.length > MAX_DEFENSES) {
    reject("defense-limit");
    return;
  }

  world.defenseSeq += 1;
  world.defenses.push(...fresh);
  events.push({
    k: "defense.placed",
    tick,
    id,
    kind: action.kind,
    conduit: target.conduit,
    links: fresh.map((d) => d.link),
    activeFrom: tick + latencyTicks,
  });
}
