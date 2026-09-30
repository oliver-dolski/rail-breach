import type { Content } from "../content/types";
import { selectorMatches } from "../core/attack/ops";
import type { TechniqueDef } from "../core/attack/types";
import type { MapperContext, NodeEntry, TechniqueEntry } from "./types";

/** The closed vocabulary of one session: techniques in catalogue order, nodes in content order. */
export function buildMapperContext(
  content: Content,
  techniques: readonly TechniqueDef[],
): MapperContext {
  const entries: TechniqueEntry[] = techniques.map((t) => ({
    id: t.id,
    ...(t.legacyId === undefined ? {} : { legacyId: t.legacyId }),
    name: t.name,
    tactic: t.tactic,
    targets: t.targets,
  }));
  const nodes: NodeEntry[] = content.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    kind: n.kind,
    zone: n.zone,
    roles: [...n.roles],
    tags: [...n.tags],
  }));
  const roles = [...new Set(nodes.flatMap((n) => n.roles))].sort();
  const zones = content.zones.map((z) => z.id);
  return { techniques: entries, nodes, roles, zones };
}

/** The nodes a technique may be aimed at, in content order. */
export function validTargets(technique: TechniqueEntry, ctx: MapperContext): NodeEntry[] {
  return ctx.nodes.filter((n) => selectorMatches(technique.targets, n));
}
