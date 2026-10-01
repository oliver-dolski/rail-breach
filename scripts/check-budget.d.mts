export const BASELINE_JS_BYTES: number;
export const BASELINE_CSS_BYTES: number;
export const JS_GROWTH_BYTES: number;
export const CSS_GROWTH_BYTES: number;
export const FONT_BYTES: number;
export function budgetVerdict(sizes: { js: number; css: number; fonts: number[] }): {
  ok: boolean;
  reasons: string[];
};
export function measure(assetsDir: string): { js: number; css: number; fonts: number[] };
