import { describe, expect, it } from "vitest";
import { createAttractSession, stampAction } from "../../src/app/session";
import { network } from "../../src/content/network";
import { phishingDispatcher } from "../../src/content/scenarios/phishing-dispatcher";
import { techniques } from "../../src/content/techniques";
import { buildMapperContext, validTargets } from "../../src/mapper/context";
import type { TechniqueEntry } from "../../src/mapper/types";
import { filterTechniques, launchAction, rowLabel } from "../../src/ui/panel/picker";

const ctx = buildMapperContext(network, techniques);
const ids = (query: string): string[] => filterTechniques(ctx.techniques, query).map((t) => t.id);
const entry = (id: string): TechniqueEntry => {
  const found = ctx.techniques.find((t) => t.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe("the technique picker's search", () => {
  it("lists all 13 techniques for an empty or blank query", () => {
    expect(ids("")).toHaveLength(13);
    expect(ids("   ")).toHaveLength(13);
  });

  it("finds a technique by its current id", () => {
    expect(ids("T1692.001")).toEqual(["T1692.001"]);
    expect(ids("t0865")).toEqual(["T0865"]);
  });

  it("finds a revoked technique by its legacy id", () => {
    expect(ids("T0855")).toEqual(["T1692.001"]);
    expect(ids("T0803")).toEqual(["T1691.001"]);
    expect(ids("t0856")).toEqual(["T1692.002"]);
  });

  it("finds a technique by a part of its name, in any case", () => {
    expect(ids("denial")).toEqual(["T0813"]);
    expect(ids("LOSS OF")).toEqual(["T0829", "T0880"]);
  });

  it("finds a technique by everyday wording, so 'spoof' finds the reporting message", () => {
    expect(ids("spoof")).toContain("T1692.002");
  });

  it("returns nothing for a word nothing carries", () => {
    expect(ids("zzzz")).toEqual([]);
  });

  it("keeps the catalogue order, the same on every call", () => {
    const order = techniques.map((t) => t.id);
    expect(ids("")).toEqual(order);
    expect(ids("")).toEqual(ids(""));
    const hit = ids("a");
    expect(hit).toEqual(order.filter((id) => hit.includes(id)));
    expect(ids("a")).toEqual(hit);
  });

  it("words a row with the old id when there is one", () => {
    expect(rowLabel(entry("T1692.002"))).toBe(
      "T1692.002 (was T0856) Unauthorized Message: Reporting Message",
    );
    expect(rowLabel(entry("T0865"))).toBe("T0865 Spearphishing Attachment");
  });
});

describe("the nodes a picked technique may be aimed at", () => {
  it("are the ones its target selector admits, in content order", () => {
    expect(validTargets(entry("T0865"), ctx).map((n) => n.id)).toEqual([
      "corp-ws-dispatch",
      "corp-ws-office",
    ]);
    expect(validTargets(entry("T0822"), ctx).map((n) => n.id)).toEqual(["vpn-gw"]);
  });

  it("are every node for a technique that names no selector", () => {
    expect(validTargets(entry("T0840"), ctx)).toHaveLength(ctx.nodes.length);
  });
});

describe("picking a technique launches it through the live path", () => {
  const START = phishingDispatcher.startTick;

  it("stamps the launch at world.tick + 1 and the engine starts it then", () => {
    const session = createAttractSession();
    session.advance(3);
    const action = launchAction("T0865", "corp-ws-office");
    expect(action).toEqual({
      type: "technique.launch",
      technique: "T0865",
      target: "corp-ws-office",
    });
    const stamped = stampAction(session.world(), action);
    expect(stamped.t).toBe(session.world().tick + 1);

    session.dispatch(action);
    expect(session.live()).toBe(true);
    session.advance(5);
    const events = session.drainEvents();
    const op = events.find((e) => e.k === "op.started" && e.target === "corp-ws-office");
    expect(op?.tick).toBe(START + 3 + 1);
  });

  it("surfaces the existing refusal for a target the technique cannot take, and keeps running", () => {
    const session = createAttractSession();
    session.dispatch(launchAction("T0865", "tms-server"));
    session.advance(5);
    const refusal = session.drainEvents().find((e) => e.k === "technique.rejected");
    expect(refusal).toMatchObject({ technique: "T0865", target: "tms-server" });
    expect(refusal?.k === "technique.rejected" ? refusal.reasons.join(" ") : "").toContain(
      "not a valid target",
    );
    expect(session.status().held).toBe(true);
    expect(session.status().failure).toBeUndefined();
  });
});
