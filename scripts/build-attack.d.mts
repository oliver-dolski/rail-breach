export const ATTACK_VERSION: string;
export const SOURCE_URL: string;
export const SOURCE_SHA256: string;
export const CURRENT_IDS: string[];
export const LEGACY_IDS: string[];

export interface CatalogEntry {
  id: string;
  name: string;
  /** The first ICS tactic the bundle lists for the technique. */
  tactic: string;
  /** Every ICS tactic the bundle lists, in bundle order. */
  tactics: string[];
  /** On a current technique: the revoked ID it replaced. */
  legacyId?: string;
  revoked: boolean;
  /** On a revoked technique: the current ID that replaced it. */
  supersededBy?: string;
  attackVersion: string;
  /** STIX object id the entry was read from. */
  source: string;
}

export interface Catalog {
  attackVersion: string;
  source: { url: string; sha256: string; collection: string; modified: string };
  techniques: CatalogEntry[];
}

export function buildCatalog(bundle: unknown, meta: { sha256: string; url: string }): Catalog;
export function serialise(value: unknown): string;
export function sha256Hex(bytes: Uint8Array): string;
