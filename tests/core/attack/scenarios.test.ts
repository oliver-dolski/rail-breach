import { describe, expect, it } from "vitest";
import { catalog, entryFor } from "../../../src/app/catalog";
import { createAttractSession } from "../../../src/app/session";
import { network } from "../../../src/content/network";
import {
  insiderSignalbox,
  phishingDispatcher,
  type Scenario,
  scenarios,
  vendorVpn,
} from "../../../src/content/scenarios";
import { validateScenario } from "../../../src/content/scenarios/validate";
import { techniques } from "../../../src/content/techniques";
import { ContentError } from "../../../src/content/validate";
import type { TimedAction } from "../../../src/core/replay/recording";
import type { SimEvent } from "../../../src/core/sim/events";
import { step } from "../../../src/core/sim/step";
import { createWorld, type World } from "../../../src/core/sim/world";
import { networkIndex } from "../../fixtures/attack";

const index = networkIndex();
const SECOND = 10;

interface Trace {
  world: World;
  events: SimEvent[];
  /** Speed and position of every train on each tick from the scenario's start. */
  trains: Map<number, Map<string, { speed: number; pos: number }>>;
}

/** Runs a scenario's actions from tick 0 with the real engine, keeping what the tests look at. */
function simulate(scenario: Scenario, actions: readonly TimedAction[]): Trace {
  const byTick = new Map<number, TimedAction["a"][]>();
  for (const { t, a } of actions) byTick.set(t, [...(byTick.get(t) ?? []), a]);
  let world = createWorld(network, scenario.seed);
  const events: SimEvent[] = [];
  const trains: Trace["trains"] = new Map();
  while (world.tick < scenario.durationTicks) {
    const result = step(world, byTick.get(world.tick + 1) ?? [], index);
    world = result.world;
    events.push(...result.events);
    if (world.tick >= scenario.startTick) {
      trains.set(
        world.tick,
        new Map(world.trains.map((t) => [t.id, { speed: t.speedDmPerTick, pos: t.posDm }])),
      );
    }
  }
  return { world, events, trains };
}

const isAttack = (x: TimedAction): boolean =>
  x.a.type === "technique.launch" || x.a.type === "playbook.start";

const kinds = <K extends SimEvent["k"]>(events: SimEvent[], k: K) =>
  events.filter((e): e is Extract<SimEvent, { k: K }> => e.k === k);

/**
 * The first train the attack stopped: one that was moving in the quiet railway when it halted
 * at a signal after the chain landed, and that the quiet railway has long since moved on.
 */
function firstCausedHalt(attacked: Trace, quiet: Trace, landing: number): number {
  for (const e of kinds(attacked.events, "train.stopped")) {
    if (e.cause !== "signal" || e.tick <= landing) continue;
    const now = quiet.trains.get(e.tick)?.get(e.train);
    const later = quiet.trains.get(e.tick + 250)?.get(e.train);
    if (now !== undefined && now.speed > 0 && (later === undefined || later.pos > now.pos + 300)) {
      return e.tick;
    }
  }
  throw new Error("the attack held no train");
}

const story = (scenario: Scenario) => {
  const attacked = simulate(scenario, scenario.actions);
  const quiet = simulate(
    scenario,
    scenario.actions.filter((x) => !isAttack(x)),
  );
  // The first thing the intruder does: a payload on the wire, or work on a machine they already hold.
  const firstPacket = kinds(attacked.events, "op.started")[0]?.tick ?? 0;
  const done = kinds(attacked.events, "technique.succeeded");
  const landing = done.at(-1)?.tick ?? 0;
  return { attacked, quiet, firstPacket, done, landing };
};

describe("the three scenarios are valid content", () => {
  it("are listed in the order of the selector, each with a recording", () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      "phishing-dispatcher",
      "vendor-vpn",
      "insider-signalbox",
    ]);
    expect(catalog.map((e) => e.scenario)).toEqual([...scenarios]);
    for (const s of scenarios) expect(entryFor(s.id)?.recording).toBeDefined();
    expect(entryFor("nowhere")).toBeUndefined();
  });

  it("pass validation and use only resolved technique, playbook, breach and sensor actions", () => {
    for (const scenario of scenarios) {
      expect(() => validateScenario(scenario, network, techniques), scenario.id).not.toThrow();
      for (const { a } of scenario.actions) {
        expect(["technique.launch", "playbook.start", "assume.breach", "defense.place"]).toContain(
          a.type,
        );
        if (a.type === "defense.place") expect(a.kind).toBe("ids");
      }
      expect(scenario.title).not.toBe("");
      expect(scenario.summary).not.toBe("");
    }
  });

  it("keep names fictional and captions at technique-name level: no address, CVE, product or command", () => {
    const text = JSON.stringify(scenarios);
    expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(text).not.toMatch(/CVE-\d{4}-\d+/i);
    expect(text).not.toMatch(/\.(?:exe|dll|ps1|sh|bat)\b|powershell|cmd\.exe|\/bin\//i);
    for (const s of scenarios) {
      expect(s.summary.length).toBeLessThan(200);
      expect(`${s.title} ${s.summary}`).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});

describe("each scenario plays through the session, verified against its recording", () => {
  for (const { scenario } of catalog) {
    it(`${scenario.id} runs to its end with the invariant held and no mismatch`, () => {
      const session = createAttractSession({ scenario });
      expect(session.scenario.id).toBe(scenario.id);
      expect(session.world().tick).toBe(scenario.startTick);
      const restarts = session.generation();
      while (session.world().tick < scenario.durationTicks) session.advance(50);
      expect(session.status().failure).toBeUndefined();
      expect(session.status().held).toBe(true);
      expect(session.generation()).toBe(restarts);
    });
  }
});

describe("an assumed breach is told at the start of every show", () => {
  it("opens the insider show with the breach, again after the show starts over, and never for the others", () => {
    const insider = createAttractSession({ scenario: insiderSignalbox });
    expect(insider.drainEvents()).toEqual([
      { k: "breach.assumed", tick: insiderSignalbox.startTick, node: "mws-vel" },
    ]);
    insider.advance(10);
    insider.reset();
    insider.advance(1);
    expect(insider.drainEvents().map((e) => e.k)).toContain("breach.assumed");
    for (const scenario of [phishingDispatcher, vendorVpn]) {
      const session = createAttractSession({ scenario });
      session.advance(5);
      expect(session.drainEvents().map((e) => e.k)).not.toContain("breach.assumed");
    }
  });
});

describe("Vendor VPN", () => {
  const run = story(vendorVpn);

  it("walks the vendor path: the gateway, the jump host, the engineering workstation, then an interlocking", () => {
    expect(run.done.map((e) => [e.technique, e.node])).toEqual([
      ["T0822", "vpn-gw"],
      ["T0840", "vpn-gw"],
      ["T0886", "vendor-jump"],
      ["T0886", "ctrl-eng-ws"],
      ["T0880", "il-tav"],
    ]);
    expect(kinds(run.attacked.events, "technique.failed")).toEqual([]);
    expect(kinds(run.attacked.events, "technique.rejected")).toEqual([]);
    expect(kinds(run.attacked.events, "op.blocked")).toEqual([]);
  });

  it("bypasses the DMZ that the office path must cross", () => {
    const links = new Set(kinds(run.attacked.events, "packet").map((p) => p.link));
    expect(links.has("l-net-vpn")).toBe(true);
    expect(links.has("l-jump-eng")).toBe(true);
    expect([...links].some((l) => l.includes("dmz"))).toBe(false);
    const dmz = run.attacked.world.nodes.find((n) => n.id === "dmz-relay");
    expect(dmz?.integrity).toBe(0);
  });

  it("ends with the interlocking out of service: signals dark, trains standing, nothing unsafe", () => {
    const il = run.attacked.world.nodes.find((n) => n.id === "il-tav");
    expect(il?.availability).toBe("down");
    expect(kinds(run.attacked.events, "interlocking.health")).toContainEqual(
      expect.objectContaining({ il: "IL-TAV", health: "down" }),
    );
    expect(kinds(run.attacked.events, "train.overran")).toEqual([]);
  });

  it("starts within a second of the show, lands in about 23 s and stops a train right behind it", () => {
    expect(run.firstPacket - vendorVpn.startTick).toBeLessThanOrEqual(SECOND);
    expect(run.landing - run.firstPacket).toBeLessThanOrEqual(25 * SECOND);
    const halt = firstCausedHalt(run.attacked, run.quiet, run.landing);
    expect(halt - run.firstPacket).toBeLessThanOrEqual(26 * SECOND);
  });

  it("is the attack that stopped them: the quiet railway keeps running", () => {
    expect(kinds(run.quiet.events, "interlocking.health")).toEqual([]);
    expect(run.quiet.world.trains.some((t) => t.speedDmPerTick > 0)).toBe(true);
  });
});

describe("Insider in the signal box", () => {
  const run = story(insiderSignalbox);

  it("starts from an assumed breach: the workstation is held from the first tick and nothing else is", () => {
    const first = simulate(
      { ...insiderSignalbox, durationTicks: 1 },
      insiderSignalbox.actions.filter((x) => x.a.type === "assume.breach"),
    );
    const held = first.world.nodes.filter((n) => n.integrity > 0).map((n) => n.id);
    expect(held).toEqual(insiderSignalbox.initialFootholds);
    expect(kinds(first.events, "breach.assumed")).toEqual([
      expect.objectContaining({ tick: 1, node: "mws-vel" }),
    ]);
  });

  it("needs that foothold: without it the first step that needs one is refused and nothing lands", () => {
    const without = simulate(
      insiderSignalbox,
      insiderSignalbox.actions.filter((x) => x.a.type !== "assume.breach"),
    );
    expect(kinds(without.events, "technique.rejected")[0]?.reasons.join(" ")).toContain(
      "no foothold on mws-vel",
    );
    expect(kinds(without.events, "technique.succeeded").map((e) => e.technique)).not.toContain(
      "T0880",
    );
  });

  it("maps the workstation, opens the interlocking with the account, slows it, then takes it out", () => {
    expect(run.done.map((e) => [e.technique, e.node])).toEqual([
      ["T0840", "mws-vel"],
      ["T0859", "il-vel"],
      ["T0836", "il-vel"],
      ["T0880", "il-vel"],
    ]);
    expect(kinds(run.attacked.events, "technique.failed")).toEqual([]);
    expect(kinds(run.attacked.events, "technique.rejected")).toEqual([]);
    const il = run.attacked.world.nodes.find((n) => n.id === "il-vel");
    expect(il?.availability).toBe("down");
    expect(il?.paramClampPermille).toBeLessThan(1000);
    expect(kinds(run.attacked.events, "train.overran")).toEqual([]);
  });

  it("never leaves the signal box: the whole chain is maintenance traffic on two links", () => {
    const links = new Set(kinds(run.attacked.events, "packet").map((p) => p.link));
    expect([...links]).toEqual(["l-mws-vel"]);
  });

  it("starts within a second, lands in about 21 s and stops a train right behind it", () => {
    expect(run.firstPacket - insiderSignalbox.startTick).toBeLessThanOrEqual(SECOND);
    expect(run.landing - run.firstPacket).toBeLessThanOrEqual(22 * SECOND);
    const halt = firstCausedHalt(run.attacked, run.quiet, run.landing);
    expect(halt - run.firstPacket).toBeLessThanOrEqual(23 * SECOND);
  });
});

describe("Phishing to the dispatcher with its sensors", () => {
  const bare = phishingDispatcher.actions.filter((x) => x.a.type !== "defense.place");
  const sensors = phishingDispatcher.actions.filter((x) => x.a.type === "defense.place");
  const withSensors = story(phishingDispatcher);

  it("starts with monitoring in place on the two conduits the chain crosses", () => {
    expect(sensors.map((x) => x.a)).toEqual([
      { type: "defense.place", kind: "ids", on: { conduit: "c-corp-dmz" } },
      { type: "defense.place", kind: "ids", on: { conduit: "c-dmz-ctrl" } },
    ]);
    for (const x of sensors) expect(x.t).toBeLessThan(phishingDispatcher.startTick);
  });

  it("raises an IDS alert with no click, after the first action and before the chain has landed", () => {
    const alerts = kinds(withSensors.attacked.events, "ids.alert");
    expect(alerts.length).toBeGreaterThan(0);
    const first = alerts[0];
    expect(first?.sensor).not.toBe("baseline");
    expect(first?.tick).toBeGreaterThan(withSensors.firstPacket);
    expect(first?.tick).toBeLessThan(withSensors.landing);
    expect(withSensors.attacked.world.detectedAt).toBe(first?.tick);
  });

  it("leaves the railway story exactly as it was: same signals, same halts, same routes", () => {
    const without = story({ ...phishingDispatcher, actions: bare });
    const rail = (events: SimEvent[]) =>
      events.filter((e) => e.k !== "ids.alert" && e.k !== "defense.placed");
    expect(rail(withSensors.attacked.events)).toEqual(rail(without.attacked.events));
    expect(without.attacked.world.trains).toEqual(withSensors.attacked.world.trains);
    expect(without.attacked.world.nodes).toEqual(withSensors.attacked.world.nodes);
    expect(kinds(without.attacked.events, "ids.alert")).toEqual([]);
  });

  it("still drops the signals within 18 s of the first packet and halts a train within 33 s", () => {
    // Signals go to stop the moment the chain lands.
    const stops = kinds(withSensors.attacked.events, "signal.aspect").filter(
      (e) => e.tick === withSensors.landing && e.aspect === "stop",
    );
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(withSensors.landing - withSensors.firstPacket).toBeLessThanOrEqual(18 * SECOND);
    const halt = firstCausedHalt(withSensors.attacked, withSensors.quiet, withSensors.landing);
    expect(halt - withSensors.firstPacket).toBeLessThanOrEqual(33 * SECOND);
  });
});

describe("a scenario that does not fit the content is refused whole", () => {
  const good = insiderSignalbox;
  const problems = (scenario: Scenario): string[] => {
    try {
      validateScenario(scenario, network, techniques);
    } catch (error) {
      if (error instanceof ContentError) return [...error.problems];
      throw error;
    }
    return [];
  };

  it("accepts the real one", () => {
    expect(problems(good)).toEqual([]);
  });

  it("refuses a foothold on a machine that does not exist or on the Internet", () => {
    expect(problems({ ...good, initialFootholds: ["mws-nowhere"] }).join("\n")).toMatch(
      /unknown node "mws-nowhere"/,
    );
    expect(problems({ ...good, initialFootholds: ["internet"] }).join("\n")).toMatch(
      /outside world/,
    );
  });

  it("refuses a foothold list that the actions do not back, and the reverse", () => {
    expect(problems({ ...good, initialFootholds: [] }).join("\n")).toMatch(/does not list/);
    expect(
      problems({ ...good, actions: good.actions.filter((x) => x.a.type !== "assume.breach") }).join(
        "\n",
      ),
    ).toMatch(/nothing assumes the breach/);
    expect(problems({ ...good, initialFootholds: ["mws-vel", "mws-vel"] }).join("\n")).toMatch(
      /twice/,
    );
  });

  it("refuses an assumed breach later than the first tick", () => {
    const late = good.actions.map((x) => (x.a.type === "assume.breach" ? { ...x, t: 50 } : x));
    expect(problems({ ...good, actions: late }).join("\n")).toMatch(/not at the first tick/);
  });

  it("refuses unknown techniques, nodes and conduits, and a scenario out of order", () => {
    const bad: Scenario = {
      ...good,
      actions: [
        { t: 10, a: { type: "technique.launch", technique: "T9999", target: "il-vel" } },
        { t: 5, a: { type: "technique.launch", technique: "T0840", target: "nowhere" } },
        { t: 20, a: { type: "defense.place", kind: "ids", on: { conduit: "c-nowhere" } } },
        ...good.actions,
      ],
    };
    const text = problems(bad).join("\n");
    expect(text).toMatch(/unknown T9999/);
    expect(text).toMatch(/unknown "nowhere"/);
    expect(text).toMatch(/not in the content/);
    expect(text).toMatch(/not in tick order/);
  });

  it("refuses a launch or a playbook step that no machine can ever satisfy, naming the step", () => {
    // T0865 can only be aimed at corporate workstations.
    const bad: Scenario = {
      ...good,
      actions: [
        ...good.actions,
        { t: 10, a: { type: "technique.launch", technique: "T0865", target: "il-vel" } },
        {
          t: 20,
          a: {
            type: "playbook.start",
            steps: [
              { technique: "T0865", target: { role: "dispatcher-ws" } },
              { technique: "T0865", target: { node: "il-vel" } },
              { technique: "T0865", target: { role: "no-such-role" } },
              { technique: "T0865", target: { zone: "trackside" } },
            ],
          },
        },
      ],
    };
    const text = problems(bad).join("\n");
    expect(text).toMatch(/aims T0865 at "il-vel", which it cannot target/);
    expect(text).toMatch(/step 2: "il-vel" is not a valid target for T0865/);
    expect(text).toMatch(/step 3: no machine with role "no-such-role"/);
    expect(text).toMatch(/step 4: no machine with zone "trackside"/);
    expect(text).not.toMatch(/step 1:/);
  });

  it("an engine that is handed the list of a scenario that failed validation never starts it", () => {
    expect(() =>
      createAttractSession({
        scenario: { ...good, initialFootholds: ["mws-nowhere"] },
        recording: entryFor(good.id)?.recording,
      }),
    ).toThrow(ContentError);
  });
});
