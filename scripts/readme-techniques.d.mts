export const START: string;
export const END: string;
export function techniqueUrl(id: string): string;
export function renderBlock(catalogue: {
  attackVersion: string;
  source: { sha256: string };
  techniques: {
    id: string;
    name: string;
    tactics: string[];
    revoked: boolean;
    legacyId?: string;
  }[];
}): string;
export function applyBlock(readme: string, block: string): string;
export function currentBlock(readme: string): string | null;
