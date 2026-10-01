import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { techniques } from "../../src/content/techniques";
import type { Action } from "../../src/core/sim/actions";
import { isAction } from "../../src/core/sim/actions";
import { buildMapperContext } from "../../src/mapper/context";
import { mapKeywords } from "../../src/mapper/keyword";
import { TARGET_HINTS } from "../../src/mapper/synonyms";
import type { MapResult, TechniqueMapper } from "../../src/mapper/types";
import { setText } from "../../src/ui/dom";
import {
  chipItems,
  chipNamesFrom,
  createFreeText,
  runAction,
  sourceLine,
} from "../../src/ui/panel/freetext";

const ctx = buildMapperContext(network, techniques);
const names = chipNamesFrom(layout);

describe("the interpreted-as chips", () => {
  it("show the technique id, its name and where it is aimed", () => {
    const result = mapKeywords("phishing to the dispatcher then scan the network", ctx);
    expect(chipItems(result.intents, ctx, names).map((c) => c.text)).toEqual([
      // Pins the new wording: the label the map shows, not the role id.
      "T0865 Spearphishing Attachment at Dispatcher WS",
      "T0840 Network Connection Enumeration at Dispatcher WS",
    ]);
  });

  it("name targets by their map labels, never by a role, zone or node id", () => {
    const hyphenated = ctx.roles.filter((r) => r.includes("-"));
    expect(hyphenated.length).toBeGreaterThan(0);
    for (const key of Object.keys(TARGET_HINTS)) {
      for (const text of [`phishing to the ${key}`, `scan the ${key}`]) {
        const chips = chipItems(mapKeywords(text, ctx).intents, ctx, names).map((c) => c.text);
        expect(chips.length, text).toBeGreaterThan(0);
        for (const chip of chips) {
          expect(chip, text).not.toMatch(/ role | zone | node /);
          for (const role of hyphenated) expect(chip, text).not.toContain(role);
        }
      }
    }
    expect(
      chipItems([{ technique: "T0886", target: { node: "tms-server" } }], ctx, names)[0]?.text,
    ).toMatch(/ at Traffic mgmt$/);
    expect(
      chipItems([{ technique: "T0886", target: { zone: "z-ctrl" } }], ctx, names)[0]?.text,
    ).toMatch(/ in CONTROL CENTRE$/);
  });

  it("have unique keys in order, so the list keeps the order of the steps", () => {
    const items = chipItems(mapKeywords("T0886 T0886 T0865", ctx).intents, ctx, names);
    expect(items.map((c) => c.key)).toEqual(["0:T0886", "1:T0865"]);
  });

  it("carry no text of the viewer's: a hostile string cannot reach a chip or the note as markup", () => {
    const hostile = '<img src=x onerror="alert(1)"> <script>steal()</script> phishing';
    const result = mapKeywords(hostile, ctx);
    const shown = [...chipItems(result.intents, ctx, names).map((c) => c.text), sourceLine(result)];
    for (const text of shown) expect(text).not.toMatch(/[<>"=]/);
  });

  it("go into the page as text: setText writes textContent and nothing else", () => {
    const el = { textContent: "" as string | null, innerHTML: "untouched" };
    setText(el, "<script>alert(1)</script>");
    expect(el.textContent).toBe("<script>alert(1)</script>");
    expect(el.innerHTML).toBe("untouched");
  });
});

describe("the source line", () => {
  it("names the offline matcher and adds what it ignored", () => {
    expect(sourceLine(mapKeywords("phishing wibble", ctx))).toBe(
      "Interpreted by the offline keyword matcher. Ignored: wibble.",
    );
  });

  it("names the LLM, and a fallback note comes through", () => {
    expect(
      sourceLine({ intents: [{ technique: "T0865" }], source: "llm", note: "Some note." }),
    ).toBe("Interpreted by the LLM. Some note.");
  });

  it("shows the message alone when nothing matched", () => {
    expect(sourceLine(mapKeywords("", ctx))).toMatch(/^Type what you want to try/);
    expect(sourceLine(mapKeywords("make me a sandwich", ctx))).toMatch(/^Nothing matched/);
  });
});

describe("running a mapping", () => {
  it("is a well-formed playbook.start for a mapping with steps", () => {
    const action = runAction(mapKeywords("phishing to the dispatcher", ctx));
    expect(action).toEqual({
      type: "playbook.start",
      steps: [{ technique: "T0865", target: { role: "dispatcher-ws" } }],
    });
    expect(isAction(action)).toBe(true);
  });

  it("is nothing for an empty mapping, so nothing launches", () => {
    expect(runAction(mapKeywords("", ctx))).toBeUndefined();
    expect(runAction(mapKeywords("make me a sandwich", ctx))).toBeUndefined();
  });
});

/** The box, its buttons and the two output elements, with listeners a test can fire. */
function fakeBox() {
  const make = () => {
    const listeners = new Map<string, ((event: { key?: string }) => void)[]>();
    const attrs: Record<string, string> = {};
    return {
      value: "",
      maxLength: 0,
      textContent: "",
      disabled: false,
      children: [] as unknown[],
      firstElementChild: null,
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      append() {},
      insertBefore(el: unknown) {
        this.children.push(el);
      },
      addEventListener(type: string, fn: (event: { key?: string }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      fire(type: string, event: { key?: string } = {}) {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
    };
  };
  const byId = new Map<string, ReturnType<typeof make>>();
  for (const id of [
    "freetext-input",
    "freetext-map",
    "freetext-chips",
    "freetext-note",
    "freetext-run",
  ]) {
    byId.set(id, make());
  }
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: make,
  } as unknown as Document;
  const get = (id: string) => byId.get(id) as ReturnType<typeof make>;
  return { doc, get };
}

describe("the box on the page", () => {
  it("drops an answer that arrives after the text was edited, and keeps Run off", async () => {
    const { doc, get } = fakeBox();
    let release: (r: MapResult) => void = () => {};
    const mapper: TechniqueMapper = {
      map: () => new Promise<MapResult>((resolve) => (release = resolve)),
    };
    const actions: Action[] = [];
    createFreeText(doc, { ctx, names, mapper, onAction: (a) => actions.push(a) });

    get("freetext-input").value = "phishing to the dispatcher";
    get("freetext-map").fire("click");
    expect(get("freetext-note").textContent).toBe("Interpreting...");

    get("freetext-input").value = "something else entirely";
    get("freetext-input").fire("input");
    release(mapKeywords("phishing to the dispatcher", ctx));
    await new Promise((r) => setTimeout(r, 0));

    expect(get("freetext-run").disabled).toBe(true);
    expect(get("freetext-note").textContent).toBe("");
    expect(get("freetext-map").disabled).toBe(false);
    get("freetext-run").fire("click");
    expect(actions).toEqual([]);
  });

  it("still shows an answer for text that was not touched", async () => {
    const { doc, get } = fakeBox();
    const mapper: TechniqueMapper = { map: async (text) => mapKeywords(text, ctx) };
    createFreeText(doc, { ctx, names, mapper, onAction: () => {} });
    get("freetext-input").value = "phishing to the dispatcher";
    get("freetext-map").fire("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(get("freetext-run").disabled).toBe(false);
    expect(get("freetext-note").textContent).toMatch(/^Interpreted by the offline keyword matcher/);
  });
});

describe("no markup sink in the input code", () => {
  const files = [
    "src/ui/panel/freetext.ts",
    "src/ui/panel/picker.ts",
    ...readdirSync("src/mapper").map((f) => join("src/mapper", f)),
  ];
  it.each(files)("%s writes no HTML", (file) => {
    const code = readFileSync(file, "utf-8");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
  });
});
