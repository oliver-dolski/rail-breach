import { describe, expect, it } from "vitest";
import { network } from "../../src/content/network";
import { techniques } from "../../src/content/techniques";
import { buildMapperContext } from "../../src/mapper/context";
import { MAX_INTENTS, validateIntents } from "../../src/mapper/schema";

const ctx = buildMapperContext(network, techniques);
const ids = (raw: unknown): string[] => validateIntents(raw, ctx).intents.map((i) => i.technique);

describe("validateIntents", () => {
  it("drops a technique that is not in the closed catalogue, and says so", () => {
    const { intents, dropped } = validateIntents(["T0865", "T9999", "rm -rf /", 7, null], ctx);
    expect(intents).toEqual([{ technique: "T0865" }]);
    expect(dropped).toHaveLength(4);
  });

  it("maps a legacy id to the current one, in any case", () => {
    expect(ids(["T0855", "t0803", " T0856 "])).toEqual(["T1692.001", "T1691.001", "T1692.002"]);
  });

  it("accepts objects as well as bare ids, and never copies an extra key", () => {
    const { intents } = validateIntents(
      [
        {
          technique: "T0865",
          target: { role: "dispatcher-ws" },
          exec: "whatever",
          params: { a: 1 },
        },
      ],
      ctx,
    );
    expect(intents).toEqual([{ technique: "T0865", target: { role: "dispatcher-ws" } }]);
    expect(Object.keys(intents[0] ?? {})).toEqual(["technique", "target"]);
  });

  it("removes repeats and keeps the order of the rest", () => {
    expect(ids(["T0886", "T0865", "T0886", "T0855", "T1692.001", "T0865"])).toEqual([
      "T0886",
      "T0865",
      "T1692.001",
    ]);
  });

  it("keeps the same technique aimed at different places", () => {
    const { intents } = validateIntents(
      [
        { technique: "T0886", target: { node: "dmz-relay" } },
        { technique: "T0886", target: { node: "dispatch-hmi-1" } },
        { technique: "T0886", target: { node: "dmz-relay" } },
      ],
      ctx,
    );
    expect(intents.map((i) => i.target)).toEqual([
      { node: "dmz-relay" },
      { node: "dispatch-hmi-1" },
    ]);
  });

  it("caps the list and drops the rest", () => {
    const all = techniques.map((t) => t.id);
    expect(all.length).toBeGreaterThan(MAX_INTENTS);
    const { intents, dropped } = validateIntents(all, ctx);
    expect(intents.map((i) => i.technique)).toEqual(all.slice(0, MAX_INTENTS));
    expect(dropped).toHaveLength(all.length - MAX_INTENTS);
  });

  it("drops a target that names nothing real but keeps the step", () => {
    const { intents, dropped } = validateIntents(
      [
        { technique: "T0865", target: { node: "no-such-node" } },
        { technique: "T0886", target: { role: "no-such-role" } },
        { technique: "T0840", target: { zone: "no-such-zone" } },
      ],
      ctx,
    );
    expect(intents).toEqual([
      { technique: "T0865" },
      { technique: "T0886" },
      { technique: "T0840" },
    ]);
    expect(dropped).toHaveLength(3);
  });

  it("drops a target the technique cannot be aimed at", () => {
    const { intents } = validateIntents(
      [
        { technique: "T0865", target: { node: "tms-server" } },
        { technique: "T0865", target: { role: "historian" } },
        { technique: "T0822", target: { zone: "z-ctrl" } },
      ],
      ctx,
    );
    expect(intents).toEqual([{ technique: "T0865" }, { technique: "T0822" }]);
  });

  it("keeps a real node, role or zone the technique admits", () => {
    const { intents } = validateIntents(
      [
        { technique: "T0865", target: { node: "corp-ws-office" } },
        { technique: "T0822", target: { role: "vendor-access" } },
        { technique: "T0880", target: { zone: "z-il-vel" } },
      ],
      ctx,
    );
    expect(intents.map((i) => i.target)).toEqual([
      { node: "corp-ws-office" },
      { role: "vendor-access" },
      { zone: "z-il-vel" },
    ]);
  });

  it("drops a target with two keys, an empty one, a non-string one and a non-object one", () => {
    const targets = [{ role: "vendor-access", node: "vpn-gw" }, {}, { role: 4 }, "vpn-gw", ["x"]];
    for (const target of targets) {
      const { intents } = validateIntents([{ technique: "T0822", target }], ctx);
      expect(intents, JSON.stringify(target)).toEqual([{ technique: "T0822" }]);
    }
  });

  it("turns anything that is not a list into nothing", () => {
    for (const raw of [undefined, null, "T0865", 7, {}, { technique: "T0865" }, () => 1]) {
      expect(validateIntents(raw, ctx).intents).toEqual([]);
    }
  });

  it("survives a hostile prototype-shaped object", () => {
    const raw = JSON.parse('[{"__proto__": {"technique": "T0865"}, "technique": "T0840"}]');
    expect(ids(raw)).toEqual(["T0840"]);
  });
});
