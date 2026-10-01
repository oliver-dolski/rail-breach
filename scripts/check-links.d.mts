export const OWN_PREFIXES: string[];
export function extractTargets(markdown: string): string[];
export function slug(heading: string): string;
export function anchors(markdown: string): Set<string>;
export function checkOffline(
  markdown: string,
  options: { file: string; tracked: Set<string>; exists?: (path: string) => boolean },
): string[];
export function checkOnline(
  markdown: string,
  options?: {
    live?: boolean;
    fetchImpl?: (url: string, init?: unknown) => Promise<{ status: number }>;
  },
): Promise<{ failures: string[]; pending: string[] }>;
