/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const DESIGNATION =
  "© 2026 The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation.";
const LICENSE_PARAGRAPH =
  "The MITRE Corporation (MITRE) hereby grants you a non-exclusive, royalty-free license to use ATT&CK® for research, development, and commercial purposes. Any copy you make for such purposes is authorized provided that you reproduce MITRE's copyright designation and this license in any such copy.";
const TRADEMARK = "MITRE ATT&CK and ATT&CK are registered trademarks of The MITRE Corporation.";
const NOT_AFFILIATED =
  "Rail Breach is an independent project and is not affiliated with The MITRE Corporation.";
const TERMS_URL = "https://attack.mitre.org/resources/legal-and-branding/terms-of-use/";

/** Visible text of the page footer: tags dropped, the three entities decoded, spaces collapsed. */
function footerText(html: string): string {
  const footer = /<footer class="panel-foot">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
  return footer
    .replace(/<[^>]+>/g, " ")
    .replace(/&copy;/g, "©")
    .replace(/&reg;/g, "®")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();
}

describe("MITRE ATT&CK attribution", () => {
  it("shows the designation, the trademark sentence and the terms link in the app footer", () => {
    const html = read("index.html");
    const text = footerText(html);
    expect(text).toContain("MITRE ATT&CK® for ICS v19.2.");
    expect(text).toContain(DESIGNATION);
    expect(text).toContain(TRADEMARK);
    expect(text).toContain("ATT&CK Terms of Use");
    expect(html).toMatch(new RegExp(`href="${TERMS_URL}"`));
  });

  it("does not suggest that MITRE endorses or reviewed the project", () => {
    const text = `${footerText(read("index.html"))}\n${read("NOTICE")}`;
    expect(text).not.toMatch(/endorse|sponsor|approved by|certified by|in partnership/i);
  });

  it.skipIf(!existsSync(join(ROOT, "dist", "index.html")))(
    "carries the designation in the built page too",
    () => {
      expect(footerText(read("dist/index.html"))).toContain(DESIGNATION);
    },
  );
});

describe("NOTICE", () => {
  const notice = read("NOTICE");

  it("quotes MITRE's designation, license and trademark wording verbatim", () => {
    expect(notice).toContain(DESIGNATION);
    expect(notice).toContain(`"${LICENSE_PARAGRAPH}"`);
    expect(notice).toContain("Licensed under the MITRE ATT&CK Terms of Use:");
    expect(notice).toContain(TRADEMARK);
    expect(notice).toContain(TERMS_URL);
    expect(notice).toContain(NOT_AFFILIATED);
  });

  it("names the catalogue file and the pinned ATT&CK for ICS version", () => {
    expect(notice).toContain("MITRE ATT&CK® for ICS, version 19.2");
    expect(notice).toContain("src/content/attack-ics.json");
    expect(notice).toContain("scripts/build-attack.mjs");
    expect(notice).toContain("ics-attack-19.2.json");
  });

  it("carries the twgl.js MIT notice exactly as the package states it", () => {
    const twgl = read("node_modules/twgl.js/LICENSE.md").trim();
    expect(twgl).toMatch(/^Copyright 2019 Gregg Tavares/);
    expect(notice).toContain("twgl.js 7.0.0 (https://twgljs.org)");
    expect(notice).toContain(twgl);
  });

  it("is UTF-8 with LF line endings", () => {
    expect(notice).not.toContain("\r");
    expect(notice.startsWith("Rail Breach\nCopyright 2026 Oliver Dolski\n")).toBe(true);
  });
});

describe("LICENSE", () => {
  const license = read("LICENSE");

  it("is the Apache License 2.0 granted by the owner", () => {
    expect(license.trimStart().startsWith("Apache License\n")).toBe(true);
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("Copyright 2026 Oliver Dolski");
    expect(license).not.toContain("\r");
  });

  it.skipIf(!existsSync(join(ROOT, "..", "wayside", "LICENSE")))(
    "is byte for byte the licence of the sibling repository",
    () => {
      expect(license).toBe(read("../wayside/LICENSE"));
    },
  );
});

describe("the attribution footer style", () => {
  const css = read("src/ui/style.css");

  it("gives the terms link its own colour and a visible keyboard focus ring", () => {
    expect(css).toMatch(/\.attribution a \{[^}]*color: var\(--detection\)/);
    expect(css).toMatch(/\.attribution a:focus-visible \{[^}]*outline: 2px solid/);
  });
});
