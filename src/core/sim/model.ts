import type { Content } from "../../content/types";
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
  /** Run assertInvariants after every step. On in tests and dev builds. */
  checkInvariants: boolean;
}

export interface IndexOptions {
  checkInvariants?: boolean;
}

export function buildIndex(content: Content, options: IndexOptions = {}): Index {
  return {
    rail: buildRailIndex(content.tracks),
    net: buildNetIndex(content),
    checkInvariants: options.checkInvariants ?? false,
  };
}
