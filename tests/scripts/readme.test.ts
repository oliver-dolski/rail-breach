/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anchors,
  checkOffline,
  checkOnline,
  extractTargets,
  OWN_PREFIXES,
  slug,
} from "../../scripts/check-links.mjs";
import {
  applyBlock,
  currentBlock,
  END,
  renderBlock,
  START,
} from "../../scripts/readme-techniques.mjs";
import attackCatalog from "../../src/content/attack-ics.json";

/**
 * The README is the public face of the repository, read by exactly the audience that checks
 * its claims. These tests pin its structure, the wording rules about safety, the generated
 * technique table and the links.
 */

const ROOT = process.cwd();
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** The prose with line breaks folded, so a phrase is found wherever the paragraph wraps. */
const flat = readme.replace(/\s+/g, " ");

const HEADINGS = [
  "What you see",
  "Scenarios",
  "Try your own",
  "Defend the line",
  "Fail-safe by design",
  "ATT&CK for ICS v19.2",
  "How it works",
  "Run it locally",
  "Scope and disclaimer",
  "License",
];

const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

const node = (...args: string[]) =>
  spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });

describe("README structure", () => {
  it("has the sections in order", () => {
    const found = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(found).toEqual(HEADINGS);
  });

  it("has both badges, the Pages link and the tracked GIF teaser", () => {
    expect(readme).toContain(
      "[![CI](https://github.com/oliver-dolski/rail-breach/actions/workflows/deploy.yml/badge.svg)](https://github.com/oliver-dolski/rail-breach/actions/workflows/deploy.yml)",
    );
    expect(readme).toContain(
      "[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)",
    );
    expect(readme).toContain("https://oliver-dolski.github.io/rail-breach/");
    expect(readme).toMatch(/!\[[^\]]+\]\(docs\/media\/teaser\.gif\)/);
    const tracked = execFileSync("git", ["ls-files", "docs/media/teaser.gif"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(tracked.trim()).toBe("docs/media/teaser.gif");
  });

  it("names the three scenarios by the titles the app shows", () => {
    for (const title of ["Phishing to the dispatcher", "Vendor VPN", "Insider in the signal box"]) {
      expect(readme, title).toContain(title);
    }
  });

  it("quotes the GIF speed the capture script uses", () => {
    expect(flat).toContain("2x real speed");
  });
});

describe("README wording rules", () => {
  it("describes the overrun as contained by the overlap", () => {
    expect(flat).toContain("contained by the overlap");
  });

  it("never claims that a train cannot pass a signal at stop", () => {
    expect(flat).not.toMatch(/never pass(es)?( a)? (stop signal|signal at stop|signal at danger)/i);
    expect(flat).not.toMatch(/cannot pass( a)? (stop signal|signal at stop|signal at danger)/i);
  });

  it("uses no long dash, no emoji and no exclamation mark", () => {
    expect(readme).not.toMatch(LONG_DASH);
    // The copyright and registered signs of the MITRE designation are pictographic by Unicode's lights.
    expect(readme.replace(/[©®]/g, "")).not.toMatch(/\p{Extended_Pictographic}/u);
    // Image syntax and the HTML comment markers carry a bang; prose does not.
    expect(readme.replaceAll("![", "[").replaceAll("<!--", "<")).not.toContain("!");
  });

  it("is not an attack playbook: no CVE number, no command line against a host", () => {
    expect(readme).not.toMatch(/CVE-\d{4}-\d+/i);
    expect(readme).not.toMatch(/\b(nmap|metasploit|mimikatz|msfvenom)\b/i);
  });

  it("carries the MITRE designation, the trademark sentence and the not-affiliated sentence", () => {
    expect(flat).toContain(
      "© 2026 The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation.",
    );
    expect(flat).toMatch(/registered trademarks of The MITRE Corporation/);
    expect(flat).toMatch(/not affiliated with The MITRE Corporation/i);
  });

  it("says that all data is fictional", () => {
    expect(flat).toMatch(/invented/i);
    expect(flat).toMatch(/fictional/i);
    expect(flat).toMatch(/no real operator/i);
  });
});

describe("README v19.2 note", () => {
  it("shows each revoked ID together with its successor", () => {
    const pairs: [string, string][] = [
      ["T0855", "T1692.001"],
      ["T0803", "T1691.001"],
      ["T0856", "T1692.002"],
    ];
    for (const [old, now] of pairs) {
      const line = readme.split("\n").find((l) => l.includes(old) && l.includes(now));
      expect(line, `${old} next to ${now}`).toBeDefined();
    }
  });
});

describe("README technique table", () => {
  it("is generated: the script check passes", () => {
    const run = node("scripts/readme-techniques.mjs", "--check");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("lists exactly the 13 current techniques of the catalogue", () => {
    const block = currentBlock(readme) ?? "";
    const rows = block.split("\n").filter((l) => /^\| \[T\d{4}/.test(l));
    const current = attackCatalog.techniques.filter((t) => !t.revoked).map((t) => t.id);
    expect(current).toHaveLength(13);
    expect(rows.map((r) => /\[(T[\d.]+)\]/.exec(r)?.[1]).sort()).toEqual([...current].sort());
  });

  it("renders from the catalogue and links the right attack.mitre.org pages", () => {
    const block = renderBlock(attackCatalog);
    expect(block).toContain("[T0865](https://attack.mitre.org/techniques/T0865/)");
    expect(block).toContain("[T1692.001](https://attack.mitre.org/techniques/T1692/001/)");
    expect(block).toContain(attackCatalog.source.sha256);
    expect(block).toMatch(/^\| \[T1692\.001\].*\| T0855 \|$/m);
  });

  it("replaces only what is between the markers and refuses a README without them", () => {
    const doc = `before\n${START}\nold\n${END}\nafter\n`;
    expect(applyBlock(doc, "new")).toBe(`before\n${START}\nnew\n${END}\nafter\n`);
    expect(currentBlock(applyBlock(doc, "new"))).toBe("new");
    expect(() => applyBlock("no markers", "x")).toThrow(/needs the lines/);
  });
});

describe("link checker", () => {
  const tracked = new Set(["README.md", "LICENSE", "docs/media/teaser.gif", "docs/guide/a.md"]);
  const exists = (p: string) => p === "scratch-notes.md" || tracked.has(p);

  it("accepts tracked files, folders with tracked files and real anchors", () => {
    const md = [
      "# Title",
      "## ATT&CK for ICS v19.2",
      "![x](docs/media/teaser.gif) [l](LICENSE) [d](docs/guide/) [a](#attck-for-ics-v192) [t](#title)",
      "[![CI](https://example.org/b.svg)](https://example.org/w)",
    ].join("\n");
    expect(checkOffline(md, { file: "README.md", tracked, exists })).toEqual([]);
  });

  it("fails on a missing file, an untracked file and a broken anchor", () => {
    const md = [
      "# Title",
      "[missing](docs/nope.md)",
      "![untracked](scratch-notes.md)",
      "[anchor](#no-such-heading)",
    ].join("\n");
    expect(checkOffline(md, { file: "README.md", tracked, exists })).toEqual([
      "docs/nope.md: no such file",
      "scratch-notes.md: exists but is not tracked by git",
      "#no-such-heading: no such heading",
    ]);
  });

  it("resolves a target relative to the markdown file and ignores code", () => {
    const md = "[up](../../LICENSE)\n```\n[fake](nowhere.md)\n```\n`[also](nope.md)`\n";
    expect(checkOffline(md, { file: "docs/guide/a.md", tracked, exists })).toEqual([]);
  });

  it("slugs headings the GitHub way and numbers repeats", () => {
    expect(slug("ATT&CK for ICS v19.2")).toBe("attck-for-ics-v192");
    expect(slug("Fail-safe by design")).toBe("fail-safe-by-design");
    expect([...anchors("## Run\n## Run\n")]).toEqual(["run", "run-1"]);
  });

  it("finds nested badge links and autolinks", () => {
    const md = "[![CI](https://a.example/b.svg)](https://a.example/w) <https://c.example/x>";
    expect(extractTargets(md)).toEqual([
      "https://a.example/b.svg",
      "https://a.example/w",
      "https://c.example/x",
    ]);
  });

  it("online: fails on a bad status or a network error, lists the own URLs as pending", async () => {
    const md = [
      "[ok](https://ok.example/)",
      "[gone](https://gone.example/)",
      "[down](https://down.example/)",
      `[own](${OWN_PREFIXES[0]}/actions/workflows/deploy.yml)`,
      `[pages](${OWN_PREFIXES[1]}/)`,
    ].join("\n");
    const fetchImpl = async (url: string) => {
      if (url.startsWith("https://down")) throw new Error("getaddrinfo ENOTFOUND");
      return { status: url.startsWith("https://gone") ? 404 : 200 };
    };
    const result = await checkOnline(md, { fetchImpl });
    expect(result.failures).toEqual([
      "https://gone.example/: HTTP 404",
      "https://down.example/: getaddrinfo ENOTFOUND",
    ]);
    expect(result.pending).toEqual([
      `${OWN_PREFIXES[0]}/actions/workflows/deploy.yml`,
      `${OWN_PREFIXES[1]}/`,
    ]);
    const live = await checkOnline(md, { live: true, fetchImpl: async () => ({ status: 200 }) });
    expect(live.pending).toEqual([]);
    expect(live.failures).toEqual([]);
  });

  it("the README passes offline: every relative target is tracked and every anchor exists", () => {
    const run = node("scripts/check-links.mjs", "README.md");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("the command line fails on a markdown with dead targets", () => {
    const run = node("scripts/check-links.mjs", "tests/fixtures/dead-links.md");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no/such/file.png: no such file");
    expect(run.stderr).toContain("#nothing-here: no such heading");
  });
});
