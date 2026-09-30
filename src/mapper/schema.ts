import { MAX_PLAYBOOK_STEPS } from "../core/sim/constants";
import { validTargets } from "./context";
import type { Intent, MapperContext, TechniqueEntry } from "./types";

/** The most steps one mapping may carry. The engine takes no more per playbook either. */
export const MAX_INTENTS = MAX_PLAYBOOK_STEPS;

/** The longest free text any mapper looks at. Longer text is cut, never sent on whole. */
export const MAX_TEXT_LENGTH = 500;

export interface Validated {
  intents: Intent[];
  /** What was thrown away and why, for the viewer and for tests. Never fed back to anything. */
  dropped: string[];
}

const show = (value: unknown): string => {
  const text = typeof value === "string" ? value : typeof value;
  return text.length > 24 ? `${text.slice(0, 24)}...` : text;
};

/** The catalogue entry for a current or pre-v19 id, in any case, or undefined. */
export function findTechnique(id: unknown, ctx: MapperContext): TechniqueEntry | undefined {
  if (typeof id !== "string") return undefined;
  const wanted = id.trim().toUpperCase();
  return ctx.techniques.find((t) => t.id.toUpperCase() === wanted || t.legacyId === wanted);
}

/** A target kept only if it names one real role, node or zone that the technique can be aimed at. */
function checkTarget(
  raw: unknown,
  technique: TechniqueEntry,
  ctx: MapperContext,
  dropped: string[],
): Intent["target"] {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    dropped.push(`target of ${technique.id}: not an object`);
    return undefined;
  }
  const keys = Object.keys(raw);
  const key = keys[0];
  const value = (raw as Record<string, unknown>)[key ?? ""];
  if (keys.length !== 1 || typeof value !== "string") {
    dropped.push(`target of ${technique.id}: needs exactly one of node, role, zone`);
    return undefined;
  }
  const admitted = validTargets(technique, ctx);
  if (key === "node" && admitted.some((n) => n.id === value)) return { node: value };
  if (key === "role" && admitted.some((n) => n.roles.includes(value))) return { role: value };
  if (key === "zone" && admitted.some((n) => n.zone === value)) return { zone: value };
  dropped.push(`target of ${technique.id}: ${key} ${show(value)} does not fit`);
  return undefined;
}

/**
 * The only way a mapper's output becomes something the engine may run. Accepts an array of
 * technique ids or of {technique, target} objects and keeps only what the closed catalogue
 * allows: an id that is not a current or pre-v19 technique is dropped, a pre-v19 id becomes
 * the current one, a target that names nothing real (or nothing the technique can be aimed
 * at) is dropped while the step stays, repeats are dropped, order is kept, and no more than
 * MAX_INTENTS survive. Extra keys are never copied. Anything that is not a list yields an
 * empty result, so a malformed reply can only ever do nothing.
 */
export function validateIntents(raw: unknown, ctx: MapperContext): Validated {
  const dropped: string[] = [];
  if (!Array.isArray(raw)) return { intents: [], dropped: ["not a list"] };
  const intents: Intent[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const candidate =
      typeof item === "string"
        ? { technique: item, target: undefined }
        : typeof item === "object" && item !== null && !Array.isArray(item)
          ? (item as { technique?: unknown; target?: unknown })
          : undefined;
    if (candidate === undefined) {
      dropped.push("an entry that is neither an id nor an object");
      continue;
    }
    const technique = findTechnique(candidate.technique, ctx);
    if (technique === undefined) {
      dropped.push(`technique ${show(candidate.technique)} is not in the catalogue`);
      continue;
    }
    const target = checkTarget(candidate.target, technique, ctx, dropped);
    const key = `${technique.id}|${target === undefined ? "" : JSON.stringify(target)}`;
    if (seen.has(key)) {
      dropped.push(`${technique.id} repeated`);
      continue;
    }
    if (intents.length >= MAX_INTENTS) {
      dropped.push(`${technique.id} over the limit of ${MAX_INTENTS}`);
      continue;
    }
    seen.add(key);
    intents.push(
      target === undefined ? { technique: technique.id } : { technique: technique.id, target },
    );
  }
  return { intents, dropped };
}
