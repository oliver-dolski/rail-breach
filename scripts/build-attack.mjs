#!/usr/bin/env node
// Generates src/content/attack-ics.json, the technique catalogue the rule engine
// and the ATK-06 gate trust, from the pinned ATT&CK for ICS STIX bundle. IDs,
// names and tactics are read from the bundle, never typed by hand, so they
// cannot drift from what attack.mitre.org shows.
//
// Source, in order: --source <file>, vendor/ics-attack-19.2.json, else one
// fetch of SOURCE_URL (cached into vendor/ after it passes the check). Whatever
// the origin, the bytes must hash to SOURCE_SHA256 before they are parsed. On
// any failure (missing, empty, wrong digest, not a bundle, an expected technique
// absent or in the wrong state) the script exits non-zero and writes nothing,
// so the committed catalogue is never replaced by a partial one.
//
// Only the allow-listed techniques and their revoked predecessors are kept.
// Descriptions are dropped on purpose: the catalogue carries technique names
// and nothing more.
//
// Usage: node scripts/build-attack.mjs [--source <file>] [--out <file>]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ATTACK_VERSION = "19.2";
export const SOURCE_URL =
  "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/ics-attack/ics-attack-19.2.json";
/** SHA-256 of the v19.2 bundle (git blob 2effafcbd2a672d1e2f7ca1ae403fc7a30730c5d upstream). */
export const SOURCE_SHA256 = "08b83d2cea6b6d6752468ef0e62e2ab2a53c9443ef72c439ecccb07ab9e89da9";

/** The techniques the engine implements, by exact ATT&CK ID. */
export const CURRENT_IDS = [
  "T0865",
  "T0822",
  "T0859",
  "T0886",
  "T0866",
  "T0840",
  "T1692.001",
  "T0836",
  "T1691.001",
  "T1692.002",
  "T0813",
  "T0829",
  "T0880",
];

/** IDs that were revoked in v19 and must keep resolving as aliases of a current ID. */
export const LEGACY_IDS = ["T0855", "T0803", "T0856"];

const KILL_CHAIN = "mitre-ics-attack";
const ID_SHAPE = /^T\d{4}(?:\.\d{3})?$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_FILE = join(root, "vendor", `ics-attack-${ATTACK_VERSION}.json`);
const DEFAULT_OUT = join(root, "src", "content", "attack-ics.json");

class SourceError extends Error {}

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The ATT&CK ID of a STIX object, or undefined when it has none. */
function attackId(object) {
  return object.external_references?.find((ref) => ref.source_name === "mitre-attack")?.external_id;
}

/**
 * Trims a parsed STIX bundle to the catalogue. IDs are matched exactly, in
 * dotted (T1692.001) and short (T0855) form alike; no prefix rule is used.
 * `meta` carries what is known about the bytes: { sha256, url }.
 */
export function buildCatalog(bundle, meta) {
  if (
    bundle === null ||
    typeof bundle !== "object" ||
    bundle.type !== "bundle" ||
    !Array.isArray(bundle.objects) ||
    bundle.objects.length === 0
  ) {
    throw new SourceError("the source is not a STIX bundle with objects");
  }
  const objects = bundle.objects;

  const collection = objects.find((o) => o.type === "x-mitre-collection");
  if (collection === undefined || collection.x_mitre_version !== ATTACK_VERSION) {
    throw new SourceError(
      `the bundle is ATT&CK version ${collection?.x_mitre_version ?? "unknown"}, expected ${ATTACK_VERSION}`,
    );
  }

  const byStixId = new Map(objects.map((o) => [o.id, o]));
  const patterns = new Map();
  for (const object of objects) {
    if (object.type !== "attack-pattern") continue;
    const id = attackId(object);
    if (id === undefined) continue;
    if (patterns.has(id)) throw new SourceError(`technique ${id} appears twice in the bundle`);
    patterns.set(id, object);
  }

  const parentOf = new Map();
  const revokedBy = new Map();
  for (const rel of objects) {
    if (rel.type !== "relationship") continue;
    if (rel.relationship_type === "subtechnique-of") parentOf.set(rel.source_ref, rel.target_ref);
    if (rel.relationship_type === "revoked-by") revokedBy.set(rel.source_ref, rel.target_ref);
  }

  const tacticsOf = (id, object) => {
    const tactics = (object.kill_chain_phases ?? [])
      .filter((phase) => phase.kill_chain_name === KILL_CHAIN)
      .map((phase) => phase.phase_name);
    if (tactics.length === 0) throw new SourceError(`technique ${id} has no ICS tactic`);
    return tactics;
  };

  const fullName = (id, object) => {
    if (object.x_mitre_is_subtechnique !== true) return object.name;
    const parent = byStixId.get(parentOf.get(object.id));
    if (parent === undefined) throw new SourceError(`sub-technique ${id} has no parent technique`);
    return `${parent.name}: ${object.name}`;
  };

  const entries = [];
  const legacyOf = new Map();

  for (const id of LEGACY_IDS) {
    if (!ID_SHAPE.test(id)) throw new SourceError(`malformed ID ${id} in the allow-list`);
    const object = patterns.get(id);
    if (object === undefined) throw new SourceError(`legacy technique ${id} is not in the bundle`);
    if (object.revoked !== true) throw new SourceError(`legacy technique ${id} is not revoked`);
    const successor = byStixId.get(revokedBy.get(object.id));
    const successorId = successor === undefined ? undefined : attackId(successor);
    if (successorId === undefined || !CURRENT_IDS.includes(successorId)) {
      throw new SourceError(`legacy technique ${id} is not revoked by an allow-listed technique`);
    }
    if (legacyOf.has(successorId)) {
      throw new SourceError(`technique ${successorId} would have two legacy IDs`);
    }
    legacyOf.set(successorId, id);
    const tactics = tacticsOf(id, object);
    entries.push({
      id,
      name: object.name,
      tactic: tactics[0],
      tactics,
      revoked: true,
      supersededBy: successorId,
      attackVersion: ATTACK_VERSION,
      source: object.id,
    });
  }

  for (const id of CURRENT_IDS) {
    if (!ID_SHAPE.test(id)) throw new SourceError(`malformed ID ${id} in the allow-list`);
    const object = patterns.get(id);
    if (object === undefined) throw new SourceError(`technique ${id} is not in the bundle`);
    if (object.revoked === true || object.x_mitre_deprecated === true) {
      throw new SourceError(`technique ${id} is revoked or deprecated in ATT&CK ${ATTACK_VERSION}`);
    }
    const tactics = tacticsOf(id, object);
    const entry = {
      id,
      name: fullName(id, object),
      tactic: tactics[0],
      tactics,
    };
    const legacyId = legacyOf.get(id);
    if (legacyId !== undefined) entry.legacyId = legacyId;
    entries.push({
      ...entry,
      revoked: false,
      attackVersion: ATTACK_VERSION,
      source: object.id,
    });
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    attackVersion: ATTACK_VERSION,
    source: {
      url: meta.url,
      sha256: meta.sha256,
      collection: collection.id,
      modified: collection.modified,
    },
    techniques: entries,
  };
}

/** Bytes of the bundle from the first available origin, plus where they came from. */
async function readSource(sourceArg) {
  if (sourceArg !== undefined) {
    if (!existsSync(sourceArg)) throw new SourceError(`source file ${sourceArg} does not exist`);
    return { bytes: readFileSync(sourceArg), fetched: false };
  }
  if (existsSync(VENDOR_FILE)) return { bytes: readFileSync(VENDOR_FILE), fetched: false };
  let response;
  try {
    response = await fetch(SOURCE_URL);
  } catch (error) {
    throw new SourceError(
      `cannot fetch ${SOURCE_URL} (${error.message}); place the pinned bundle at ${VENDOR_FILE}`,
    );
  }
  if (!response.ok) throw new SourceError(`fetching ${SOURCE_URL} answered ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), fetched: true };
}

/** Indented JSON with short string arrays on one line, the way the formatter lays them out. */
export function serialise(value) {
  const text = JSON.stringify(value, null, 2).replace(
    /\[\s+("(?:[^"\\]|\\.)*"(?:,\s+"(?:[^"\\]|\\.)*")*)\s+\]/g,
    (_, items) => `[${items.replace(/,\s+/g, ", ")}]`,
  );
  return `${text}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--source" || flag === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new SourceError(`${flag} needs a value`);
      args[flag.slice(2)] = resolve(value);
    } else {
      throw new SourceError(`unknown argument ${flag}`);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const { bytes, fetched } = await readSource(args.source);
  if (bytes.length === 0) throw new SourceError("the source is empty");
  const digest = sha256Hex(bytes);
  if (digest !== SOURCE_SHA256) {
    throw new SourceError(`the source hashes to ${digest}, the pin is ${SOURCE_SHA256}`);
  }
  let bundle;
  try {
    bundle = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new SourceError(`the source is not valid JSON (${error.message})`);
  }
  const catalogue = buildCatalog(bundle, { sha256: digest, url: SOURCE_URL });

  if (fetched) {
    mkdirSync(dirname(VENDOR_FILE), { recursive: true });
    writeFileSync(VENDOR_FILE, bytes);
  }
  const out = args.out ?? DEFAULT_OUT;
  const staging = `${out}.tmp`;
  writeFileSync(staging, serialise(catalogue));
  renameSync(staging, out);
  console.log(
    `${catalogue.techniques.length} techniques (ATT&CK for ICS v${ATTACK_VERSION}) -> ${out}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof SourceError) {
      console.error(`build-attack: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
