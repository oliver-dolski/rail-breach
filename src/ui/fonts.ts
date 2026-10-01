/** The two faces the panel is set in; the capture waits for both before its first frame. */
export const PANEL_FONTS: readonly string[] = [
  '600 20px "Space Grotesk"',
  '400 13px "Space Grotesk"',
];

/** The part of a FontFaceSet that loading needs, so tests can pass a plain object. */
export interface FontLoader {
  load(spec: string): Promise<unknown>;
}

/**
 * Starts loading every panel face and resolves when all of them have settled. It never rejects:
 * a blocked or missing font leaves the system fallback in place and the page keeps running.
 */
export async function loadPanelFonts(fonts: FontLoader | undefined): Promise<void> {
  if (fonts === undefined) return;
  await Promise.all(
    PANEL_FONTS.map(async (spec) => {
      try {
        await fonts.load(spec);
      } catch {
        // the fallback stack covers it
      }
    }),
  );
}
