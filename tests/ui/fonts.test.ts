/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPanelFonts, PANEL_FONTS } from "../../src/ui/fonts";

const ROOT = process.cwd();
const FONT = "src/assets/fonts/space-grotesk-latin-wght-normal.woff2";
const FONT_SHA256 = "0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d";
const css = readFileSync(join(ROOT, "src/ui/style.css"), "utf8");

describe("the pinned display face", () => {
  it("is the 22,288 byte file with the SHA-256 vetted in the UI-SPEC", () => {
    expect(statSync(join(ROOT, FONT)).size).toBe(22288);
    const sha = createHash("sha256")
      .update(readFileSync(join(ROOT, FONT)))
      .digest("hex");
    expect(sha).toBe(FONT_SHA256);
  });

  it("is declared with @font-face from a relative url, so Vite hashes it and applies the base path", () => {
    const rule = /@font-face\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).toMatch(/font-family:\s*"Space Grotesk"/);
    expect(rule).toMatch(
      /src:\s*url\("\.\.\/assets\/fonts\/space-grotesk-latin-wght-normal\.woff2"\)\s*format\("woff2"\)/,
    );
    expect(rule).toMatch(/font-weight:\s*300 700/);
    expect(rule).toMatch(/font-display:\s*swap/);
  });

  it("leads the sans stack, with system fonts behind it", () => {
    expect(css).toMatch(/--sans:\s*"Space Grotesk",\s*system-ui/);
  });

  it("sets the wordmark in it at the display size", () => {
    const rule = /\.panel h1 \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/--mono/);
    expect(rule).toMatch(/font-size:\s*20px/);
    expect(rule).toMatch(/font-weight:\s*600/);
    expect(rule).toMatch(/letter-spacing:\s*0\.14em/);
  });

  it("ships with its licence", () => {
    const ofl = readFileSync(join(ROOT, "public/fonts/OFL.txt"), "utf8");
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(ofl).toContain("Copyright 2020 The Space Grotesk Project Authors");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find any non-ASCII byte
    expect(ofl).not.toMatch(/[^\x00-\x7f]/);
  });
});

describe("loadPanelFonts", () => {
  it("names the two faces the capture and the boot wait for", () => {
    expect(PANEL_FONTS).toEqual(['600 20px "Space Grotesk"', '400 13px "Space Grotesk"']);
  });

  it("loads each face once and resolves", async () => {
    const asked: string[] = [];
    await loadPanelFonts({
      load: async (spec) => {
        asked.push(spec);
        return [];
      },
    });
    expect(asked).toEqual([...PANEL_FONTS]);
  });

  it("still resolves when a load rejects, so a blocked font never stops the page", async () => {
    let calls = 0;
    await expect(
      loadPanelFonts({
        load: () => {
          calls += 1;
          return Promise.reject(new Error("blocked"));
        },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(PANEL_FONTS.length);
  });

  it("still resolves when load throws at once or the set is missing", async () => {
    await expect(
      loadPanelFonts({
        load: () => {
          throw new Error("no");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(loadPanelFonts(undefined)).resolves.toBeUndefined();
  });
});
