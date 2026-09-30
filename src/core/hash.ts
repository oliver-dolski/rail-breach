/**
 * Canonical serialization and the checkpoint hash. Object keys are sorted by
 * UTF-16 code unit order (a total order), so the output never depends on
 * insertion order. Only plain JSON values are accepted.
 */

export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalStringify: non-finite number");
      return JSON.stringify(value);
    case "object":
      return canonicalObject(value);
    default:
      throw new Error(`canonicalStringify: unsupported ${typeof value}`);
  }
}

function canonicalObject(value: object): string {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) items.push(canonicalStringify(item === undefined ? null : item));
    return `[${items.join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("canonicalStringify: only plain objects are allowed");
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalStringify(item)}`);
  }
  return `{${parts.join(",")}}`;
}

/** 32-bit FNV-1a over UTF-16 code units. Returns a uint32. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Checkpoint hash of any plain-JSON state: 8 lowercase hex digits. */
export function stateHash(state: unknown): string {
  return fnv1a32(canonicalStringify(state)).toString(16).padStart(8, "0");
}
