import { describe, expect, it } from "vitest";
import { network } from "../../src/content/network";
import { techniques } from "../../src/content/techniques";
import { buildMapperContext } from "../../src/mapper/context";
import { keywordMapper, mapKeywords, words } from "../../src/mapper/keyword";
import { SYNONYMS, TARGET_HINTS } from "../../src/mapper/synonyms";

const ctx = buildMapperContext(network, techniques);
const ids = (text: string): string[] => mapKeywords(text, ctx).intents.map((i) => i.technique);

const PHRASES: [string, string[]][] = [
  ["phishing to the dispatcher", ["T0865"]],
  ["vendor VPN", ["T0822"]],
  ["scan the network", ["T0840"]],
  ["spoof the reports", ["T1692.002"]],
  ["insider in the signal box", ["T0859"]],
  ["blackout", ["T0829"]],
  ["block the commands then deny control", ["T1691.001", "T0813"]],
  ["deny control, then block the commands", ["T0813", "T1691.001"]],
  ["disable the safety system", ["T0880"]],
  ["send a spoofed command message", ["T1692.001"]],
  ["exploit the unpatched gateway", ["T0866"]],
  ["use stolen credentials", ["T0859"]],
  ["RDP to the traffic management server", ["T0886"]],
  ["change the speed limit parameter", ["T0836"]],
  ["phishing, then RDP into the tms, then blackout", ["T0865", "T0886", "T0829"]],
  ["T0855", ["T1692.001"]],
  ["t1692.001 and T0803", ["T1692.001", "T1691.001"]],
  ["T0856 T0865", ["T1692.002", "T0865"]],
];

describe("the keyword matcher", () => {
  it.each(PHRASES)("maps %j to %j", (text, expected) => {
    expect(ids(text)).toEqual(expected);
  });

  it("gives the same answer twice, whatever the case and spacing", () => {
    for (const [text] of PHRASES) {
      expect(mapKeywords(text, ctx)).toEqual(mapKeywords(text, ctx));
      const shouted = `   ${text.toUpperCase().replace(/ /g, "   ")}\n`;
      expect(ids(shouted), shouted).toEqual(ids(text));
    }
  });

  it("returns a MapResult marked as keyword from the async interface too", async () => {
    const result = await keywordMapper.map("vendor VPN", ctx);
    expect(result.source).toBe("keyword");
    expect(result.intents).toEqual([{ technique: "T0822", target: { role: "vendor-access" } }]);
  });

  it("aims at a role the nearest hint names when the technique can be aimed there", () => {
    expect(mapKeywords("phishing to the dispatcher", ctx).intents).toEqual([
      { technique: "T0865", target: { role: "dispatcher-ws" } },
    ]);
    expect(mapKeywords("insider in the signal box", ctx).intents).toEqual([
      { technique: "T0859", target: { role: "signal-box-ws" } },
    ]);
  });

  it("leaves the target out when no hint names a place the technique can take", () => {
    expect(mapKeywords("phishing the historian", ctx).intents).toEqual([{ technique: "T0865" }]);
    expect(mapKeywords("scan the network", ctx).intents).toEqual([{ technique: "T0840" }]);
  });

  it("runs the steps in the order they are mentioned", () => {
    expect(ids("spoof the reports then phishing")).toEqual(["T1692.002", "T0865"]);
    expect(ids("phishing then spoof the reports")).toEqual(["T0865", "T1692.002"]);
  });

  it("lists a technique once however often it is mentioned", () => {
    expect(ids("phishing phishing attachment email phish")).toEqual(["T0865"]);
  });

  it("reads a phrase that filler would shrink to one word only as typed: 'log in' is not 'log'", () => {
    expect(ids("log in to the console")).toEqual(["T0859"]);
    expect(ids("log into the console")).toEqual(["T0859"]);
    for (const text of ["read the log", "logistics", "the log files", "logs"]) {
      expect(ids(text), text).toEqual([]);
    }
  });

  it("takes a short synonym as the whole word and its plain endings, not as the start of another word", () => {
    expect(ids("jam the channel")).toEqual(["T1691.001"]);
    expect(ids("jamming the channel")).toEqual(["T1691.001"]);
    expect(ids("scanning the network")).toEqual(["T0840"]);
    expect(ids("scan the network")).toEqual(["T0840"]);
    for (const text of ["jamaica", "a scandal", "rdpx"]) {
      expect(ids(text), text).toEqual([]);
    }
    expect(ids("lured")).toEqual(["T0865"]);
    // A longer synonym still takes the start of a word.
    expect(ids("phishing")).toEqual(["T0865"]);
    expect(ids("enumeration")).toEqual(["T0840"]);
  });

  it("names the words it ignored", () => {
    const result = mapKeywords("please do phishing wibble", ctx);
    expect(result.intents.map((i) => i.technique)).toEqual(["T0865"]);
    expect(result.unmatched).toEqual(["do", "wibble"]);
    expect(result.note).toBe("Ignored: do, wibble.");
  });

  it("says so for empty or blank text and launches nothing", () => {
    for (const text of ["", "   ", "\n\t", "the of a"]) {
      const result = mapKeywords(text, ctx);
      expect(result.intents).toEqual([]);
      expect(result.source).toBe("keyword");
      expect(result.note).toMatch(/Type what you want to try/);
    }
  });

  it("says so for text that matches nothing and launches nothing", () => {
    const result = mapKeywords("make me a sandwich", ctx);
    expect(result.intents).toEqual([]);
    expect(result.note).toMatch(/Nothing matched/);
    expect(result.unmatched).toEqual(["make", "me", "sandwich"]);
  });

  it("reads only the first 500 characters and never throws on hostile text", () => {
    expect(ids(`${"x ".repeat(400)} phishing`)).toEqual([]);
    for (const text of [
      "<script>alert(1)</script>",
      "__proto__",
      "constructor",
      "\u0000￿",
      "'; DROP",
    ]) {
      expect(() => mapKeywords(text, ctx)).not.toThrow();
    }
    expect(mapKeywords("<script>alert(1)</script>", ctx).intents).toEqual([]);
  });

  it("only ever names techniques of the catalogue", () => {
    const known = new Set(techniques.map((t) => t.id));
    for (const technique of Object.keys(SYNONYMS))
      expect(known.has(technique), technique).toBe(true);
    for (const t of techniques) expect(SYNONYMS[t.id], t.id).toBeDefined();
  });

  it("names only roles some node carries in its target hints", () => {
    for (const [hint, roles] of Object.entries(TARGET_HINTS)) {
      for (const role of roles) expect(ctx.roles, `${hint} -> ${role}`).toContain(role);
    }
  });

  it("keeps its synonyms from colliding: one everyday phrase names one technique", () => {
    const owner = new Map<string, string>();
    for (const [technique, list] of Object.entries(SYNONYMS)) {
      for (const phrase of list) {
        const key = words(phrase).join(" ");
        expect(owner.get(key) ?? technique, `"${phrase}" belongs to two techniques`).toBe(
          technique,
        );
        owner.set(key, technique);
      }
    }
  });
});
