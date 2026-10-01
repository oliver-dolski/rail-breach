/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARD_GROUP, CARD_IDS, openCard } from "../../src/ui/panel/cards";

const html = readFileSync("index.html", "utf8");
const css = readFileSync("src/ui/style.css", "utf8");

/** Every element id the page had before the card layout, from the old index.html. */
const OLD_IDS = [
  "app",
  "stage",
  "map",
  "labels",
  "fallback",
  "fallback-img",
  "fallback-message",
  "view-mode",
  "view-note",
  "panel",
  "indicator-label",
  "indicator-detail",
  "scenario-select",
  "clock",
  "stat-trains",
  "stat-signals",
  "stat-nodes",
  "stat-routes",
  "stat-detect",
  "scenario-summary",
  "session-note",
  "picker-search",
  "picker-list",
  "picker-target",
  "picker-launch",
  "picker-note",
  "freetext-input",
  "freetext-map",
  "freetext-chips",
  "freetext-note",
  "freetext-run",
  "llm-key",
  "llm-save",
  "llm-model",
  "llm-forget",
  "llm-status",
  "defense-kind",
  "defense-flow",
  "defense-conduits",
  "defense-placed",
  "defense-note",
  "defense-reset",
  "compare-note",
  "compare-run",
  "compare-table",
  "compare-body",
  "compare-verdict",
  "chain",
  "caption",
  "tl-attacker",
  "tl-band-attacker",
  "tl-now-attacker",
  "tl-detection",
  "tl-band-detection",
  "tl-now-detection",
  "tl-dwell",
  "refusal-text",
  "refusal-count",
  "log",
  "alerts",
];

const idsIn = (source: string): string[] =>
  Array.from(source.matchAll(/\bid="([^"]+)"/g), (m) => m[1] as string);

/** The tag text of the element with this id. */
const tagOf = (id: string): string =>
  new RegExp(`<[a-z]+\\s[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? "";

describe("the panel as cards", () => {
  it("keeps every element id of the old page, each exactly once", () => {
    const ids = idsIn(html);
    for (const id of OLD_IDS)
      expect(
        ids.filter((x) => x === id),
        id,
      ).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders the panel: header, three open cards, seven accordion cards, footer", () => {
    const at = (needle: string): number => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      '<header class="panel-head">',
      'id="card-safety"',
      'id="card-session"',
      'id="card-chain"',
      ...CARD_IDS.slice(3).map((id) => `id="${id}"`),
      '<footer class="panel-foot">',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(CARD_IDS).toEqual([
      "card-safety",
      "card-session",
      "card-chain",
      "card-try",
      "card-defend",
      "card-compare",
      "card-timeline",
      "card-alerts",
      "card-events",
      "card-key",
    ]);
  });

  it("makes the seven lower cards one exclusive accordion with the titles in order", () => {
    expect(CARD_GROUP).toBe("panel-card");
    expect(html.match(/name="panel-card"/g)).toHaveLength(7);
    const titles = Array.from(
      html.matchAll(
        /<details id="card-[a-z]+"[^>]*>\s*<summary class="card-title">([^<]+)<\/summary>/g,
      ),
      (m) => m[1],
    );
    expect(titles).toEqual([
      "Try a technique",
      "Defend the line",
      "With and without defenses",
      "Timeline",
      "Refusals and alerts",
      "Events",
      "Key",
    ]);
  });

  it("opens only Events on first load", () => {
    for (const id of CARD_IDS.slice(3)) {
      const tag = tagOf(id);
      expect(tag, id).toContain('name="panel-card"');
      if (id === "card-events") expect(tag).toMatch(/\sopen[\s>]/);
      else expect(tag, id).not.toMatch(/\sopen[\s>]/);
    }
  });

  it("keeps the indicator markup the screen reader test reads, inside the safety card", () => {
    const safety =
      /<section id="card-safety"[\s\S]*?<\/section>\s*<\/section>/.exec(html)?.[0] ?? "";
    expect(safety).toContain('<section class="indicator"');
    expect(safety).toContain('id="indicator-label"');
    expect(safety).toContain('id="indicator-detail"');
  });

  it("uses the copy of the contract for the tagline, the session note and the card intros", () => {
    expect(html).toContain("A live attack on a fictional railway.");
    expect(html).toContain("Replayed from a recorded session.");
    for (const copy of [
      "Search by ID, name or plain words, then pick a target.",
      "Describe an attack in your own words. Nothing runs until you press Run.",
      "Pick a defense, then click a conduit on the map.",
      "The shaded gap is the time the intruder went unnoticed.",
    ]) {
      expect(html, copy).toContain(copy);
    }
  });

  it("keeps every card intro to at most 90 characters, one sentence each but the contract free-text line", () => {
    // The UI-SPEC copy for the free-text intro is itself two short sentences; it is pinned verbatim.
    const CONTRACT_TWO = "Describe an attack in your own words. Nothing runs until you press Run.";
    const intros = Array.from(
      html.matchAll(/<p\s+class="card-intro[^"]*"[^>]*>([\s\S]*?)<\/p>/g),
      (m) => (m[1] as string).replace(/\s+/g, " ").trim(),
    );
    expect(intros.length).toBeGreaterThanOrEqual(5);
    for (const text of intros) {
      expect(text.length, text).toBeLessThanOrEqual(90);
      expect(text.match(/[.!?](\s|$)/g)?.length, text).toBe(text === CONTRACT_TWO ? 2 : 1);
    }
  });

  it("keeps the disclosure that Interpret sends the text to the provider, in one short sentence", () => {
    const llm = /<details class="llm">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    const intro = /<p\s+class="card-intro[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(llm)?.[1] ?? "";
    const text = intro.replace(/\s+/g, " ").trim();
    expect(text).toMatch(/Interpret sends/);
    expect(text).toMatch(/provider/);
    expect(text.length).toBeLessThanOrEqual(90);
  });

  it("shows the documented empty states right after the lists they stand for", () => {
    const follows = (listId: string, copy: string): void => {
      const re = new RegExp(
        `id="${listId}"[^>]*></(?:ul|div)>\\s*<p class="empty-note">${copy}</p>`,
      );
      expect(html, listId).toMatch(re);
    };
    follows("log", "Waiting for the first action\\.");
    follows("chain", "No technique has run yet\\. The first one appears here\\.");
    follows("defense-placed", "No defense placed\\.");
    expect(css).toMatch(/:not\(:empty\)\s*\+\s*\.empty-note\s*\{[^}]*display:\s*none/);
  });

  it("keeps the free-text placeholder, which the keyword test maps phrase by phrase", () => {
    expect(tagOf("freetext-input")).toContain(
      'placeholder="vendor VPN, scan the network, spoof the reports"',
    );
  });

  it("keeps the log inside its card with a scroll of its own, capped at 40 percent of the viewport", () => {
    expect(css).toMatch(/#log\s*\{[^}]*max-height:\s*40vh/);
    expect(css).toMatch(/\.chain\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/scrollbar-width:\s*thin/);
    expect(css).not.toMatch(/backdrop-filter/);
  });
});

/** A document with a few <details> elements, the shape openCard reads. */
function fakeDoc(present: string[]): { doc: Document; cards: Map<string, { open: boolean }> } {
  const cards = new Map(present.map((id) => [id, { open: false }]));
  const doc = { getElementById: (id: string) => cards.get(id) ?? null } as unknown as Document;
  return { doc, cards };
}

describe("openCard", () => {
  it("opens the named card", () => {
    const { doc, cards } = fakeDoc(["card-defend", "card-events"]);
    openCard(doc, "card-defend");
    expect(cards.get("card-defend")?.open).toBe(true);
    expect(cards.get("card-events")?.open).toBe(false);
  });

  it("does nothing when the card is not on the page", () => {
    const { doc } = fakeDoc([]);
    expect(() => openCard(doc, "card-defend")).not.toThrow();
  });
});
