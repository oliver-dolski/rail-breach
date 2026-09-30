import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { network } from "../../src/content/network";
import { techniques } from "../../src/content/techniques";
import { isAction } from "../../src/core/sim/actions";
import { buildMapperContext } from "../../src/mapper/context";
import { mapKeywords } from "../../src/mapper/keyword";
import { setText } from "../../src/ui/dom";
import { chipItems, runAction, sourceLine } from "../../src/ui/panel/freetext";

const ctx = buildMapperContext(network, techniques);

describe("the interpreted-as chips", () => {
  it("show the technique id, its name and where it is aimed", () => {
    const result = mapKeywords("phishing to the dispatcher then scan the network", ctx);
    expect(chipItems(result.intents, ctx).map((c) => c.text)).toEqual([
      "T0865 Spearphishing Attachment at role dispatcher-ws",
      "T0840 Network Connection Enumeration at role dispatcher-ws",
    ]);
  });

  it("have unique keys in order, so the list keeps the order of the steps", () => {
    const items = chipItems(mapKeywords("T0886 T0886 T0865", ctx).intents, ctx);
    expect(items.map((c) => c.key)).toEqual(["0:T0886", "1:T0865"]);
  });

  it("carry no text of the viewer's: a hostile string cannot reach a chip or the note as markup", () => {
    const hostile = '<img src=x onerror="alert(1)"> <script>steal()</script> phishing';
    const result = mapKeywords(hostile, ctx);
    const shown = [...chipItems(result.intents, ctx).map((c) => c.text), sourceLine(result)];
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
