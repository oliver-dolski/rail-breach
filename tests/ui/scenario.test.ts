import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalog } from "../../src/app/catalog";
import { captionText } from "../../src/ui/panel/panel";
import { createScenarioSelect } from "../../src/ui/panel/scenario";

/** Just enough of a document for the selector: elements with text, children, a value and listeners. */
function fakeDocument() {
  const listeners: Record<string, () => void> = {};
  const select = {
    value: "",
    children: [] as { value: string; textContent: string }[],
    append(option: { value: string; textContent: string }) {
      this.children.push(option);
      if (this.value === "") this.value = option.value;
    },
    addEventListener(type: string, fn: () => void) {
      listeners[type] = fn;
    },
  };
  const summary = { textContent: "" };
  const doc = {
    getElementById: (id: string) =>
      id === "scenario-select" ? select : id === "scenario-summary" ? summary : null,
    createElement: () => {
      const el = {
        value: "",
        textContent: "",
        setAttribute(name: string, value: string) {
          if (name === "value") el.value = value;
        },
        append(text: string) {
          el.textContent += text;
        },
      };
      return el;
    },
  } as unknown as Document;
  return { doc, select, summary, fire: () => listeners.change?.() };
}

const choices = catalog.map((e) => ({
  id: e.scenario.id,
  title: e.scenario.title,
  summary: e.scenario.summary,
}));

describe("the scenario selector", () => {
  it("lists all three scenarios by title and says what the one shown is about", () => {
    const { doc, select, summary } = fakeDocument();
    const picked: string[] = [];
    const selector = createScenarioSelect(doc, choices, (id) => picked.push(id));
    expect(select.children.map((o) => o.textContent)).toEqual(choices.map((c) => c.title));
    expect(select.children.map((o) => o.value)).toEqual([
      "phishing-dispatcher",
      "vendor-vpn",
      "insider-signalbox",
    ]);
    selector.show("vendor-vpn");
    expect(select.value).toBe("vendor-vpn");
    expect(summary.textContent).toBe(choices[1]?.summary);
    expect(picked).toEqual([]);
  });

  it("hands on the id that was chosen, and ignores anything that is not a scenario", () => {
    const { doc, select, fire } = fakeDocument();
    const picked: string[] = [];
    createScenarioSelect(doc, choices, (id) => picked.push(id));
    select.value = "insider-signalbox";
    fire();
    select.value = "<img src=x onerror=alert(1)>";
    fire();
    expect(picked).toEqual(["insider-signalbox"]);
  });

  it("writes a hostile title or summary as text, never as markup", () => {
    const { doc, select, summary } = fakeDocument();
    const hostile = [{ id: "x", title: "<b>x</b>", summary: "<script>1</script>" }];
    const selector = createScenarioSelect(doc, hostile, () => undefined);
    selector.show("x");
    expect(select.children[0]?.textContent).toBe("<b>x</b>");
    expect(summary.textContent).toBe("<script>1</script>");
  });
});

describe("what the panel says before the attack starts", () => {
  const scenarios = catalog.map((e) => e.scenario);

  it("every scenario has its own idle caption, and only the phishing one names the dispatcher", () => {
    const captions = scenarios.map((s) => s.idleCaption);
    for (const caption of captions) expect(caption).not.toBe("");
    expect(new Set(captions).size).toBe(scenarios.length);
    for (const s of scenarios) {
      if (s.id !== "phishing-dispatcher") expect(s.idleCaption).not.toContain("dispatcher");
    }
  });

  it("puts a failure first, then the log's caption, then the running scenario's own idle caption", () => {
    for (const s of scenarios) {
      expect(captionText(undefined, "", s.idleCaption)).toBe(s.idleCaption);
      expect(captionText(undefined, "Something happened.", s.idleCaption)).toBe(
        "Something happened.",
      );
      expect(captionText("hash differs", "Something happened.", s.idleCaption)).toMatch(
        /hash differs/,
      );
    }
  });

  it("every scenario title fits the full-width selector", () => {
    for (const s of scenarios) expect(s.title.length, s.title).toBeLessThanOrEqual(32);
    const html = readFileSync("index.html", "utf8");
    const row = /<dd class="kv-wide">\s*<select id="scenario-select"[^>]*>/.exec(html)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(html).toMatch(/<dd class="kv-wide">\s*<select id="scenario-select"/);
  });
});
