import type { NodeKind } from "../content/types";
import type { NodeSelector, PlaybookStep } from "../core/attack/types";

/**
 * The text-to-technique seam. Whatever produces an Intent list (the offline keyword
 * matcher, an LLM) hands back the same validated shape, and only that shape ever reaches
 * the engine, as a playbook.start action. The engine never sees text.
 */

/** One resolved step: a technique of the closed catalogue and at most a node, role or zone. */
export type Intent = PlaybookStep;

export type MapSource = "keyword" | "llm";

export interface MapResult {
  /** Validated and ordered: the order the steps run in. */
  intents: Intent[];
  /** Which mapper produced the list; when the LLM failed this is "keyword" and `note` says why. */
  source: MapSource;
  /** One line for the viewer, for instance why a fallback happened or what was not understood. */
  note?: string;
  /** Words of the text that matched nothing. Display only, never sent anywhere. */
  unmatched?: string[];
}

export interface TechniqueEntry {
  id: string;
  legacyId?: string;
  name: string;
  tactic: string;
  targets: NodeSelector;
}

export interface NodeEntry {
  id: string;
  label: string;
  kind: NodeKind;
  zone: string;
  roles: string[];
  tags: string[];
}

/** The closed world a mapper may name: built from the catalogue and the topology, nothing else. */
export interface MapperContext {
  techniques: TechniqueEntry[];
  nodes: NodeEntry[];
  /** Every role some node carries, sorted. */
  roles: string[];
  zones: string[];
}

export interface TechniqueMapper {
  map(text: string, ctx: MapperContext, signal?: AbortSignal): Promise<MapResult>;
}
