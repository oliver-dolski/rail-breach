import type { Content, NodeDef } from "../../content/types";
import type { TechniqueDef } from "../attack/types";
import { buildNetIndex, type NetIndex } from "../net/graph";
import { buildRailIndex, type RailIndex } from "../rail/routes";

/**
 * Static data derived once from content and passed alongside the world. It is
 * never part of World: it is large, it never changes, and rebuilding it from
 * the same content always gives the same result.
 */
export interface Index {
  rail: RailIndex;
  net: NetIndex;
  /** Static node definitions by id (tags, hardening, awareness). */
  nodeDefs: Map<string, NodeDef>;
  /** Technique catalogue by current ID and by legacy ID. */
  techniques: Map<string, TechniqueDef>;
  /** Run assertInvariants after every step. On in tests and dev builds. */
  checkInvariants: boolean;
}

export interface IndexOptions {
  checkInvariants?: boolean;
  /** The technique catalogue. Without it every launch is refused. */
  techniques?: readonly TechniqueDef[];
}

export function buildIndex(content: Content, options: IndexOptions = {}): Index {
  const techniques = new Map<string, TechniqueDef>();
  for (const def of options.techniques ?? []) {
    techniques.set(def.id, def);
    if (def.legacyId !== undefined) techniques.set(def.legacyId, def);
  }
  return {
    rail: buildRailIndex(content.tracks),
    net: buildNetIndex(content),
    nodeDefs: new Map(content.nodes.map((n) => [n.id, n])),
    techniques,
    checkInvariants: options.checkInvariants ?? false,
  };
}
