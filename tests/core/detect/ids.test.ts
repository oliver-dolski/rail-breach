import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { techniques } from "../../../src/content/techniques";
import type { Content } from "../../../src/content/types";
import { ContentError, validateContent, validateTechniques } from "../../../src/content/validate";
import { detectionPermille, stepDetect } from "../../../src/core/detect/ids";
import type { DefenseInstance } from "../../../src/core/net/defenses";
import { counterfactual, runOutcome } from "../../../src/core/replay/counterfactual";
import type { TimedAction } from "../../../src/core/replay/recording";
import { DEFENSE_PLACEMENT_LATENCY_TICKS } from "../../../src/core/sim/constants";
import type { SimEvent } from "../../../src/core/sim/events";
import { createWorld, type World } from "../../../src/core/sim/world";
import { networkIndex, run, scenario, warmWorld } from "../../fixtures/attack";

const index = networkIndex();

type Alert = Extract<SimEvent, { k: "ids.alert" }>;
const alertsOf = (events: readonly SimEvent[]): Alert[] =>
  events.filter((e): e is Alert => e.k === "ids.alert");

const ids = (conduit: string, t: number): TimedAction => ({
  t,
  a: { type: "defense.place", kind: "ids", on: { conduit } },
});

/** The conduits the phishing chain crosses, from the mail gateway to the traffic server. */
const CHAIN_CONDUITS = ["c-net-corp", "c-corp-dmz", "c-dmz-ctrl"];
const sensorsOnChain = (): TimedAction[] =>
  CHAIN_CONDUITS.map((conduit, i) => ids(conduit, scenario.startTick + 2 + i));

const END = 31000;

/** One hop of `technique` over `link`, as the operations report it. */
const packet = (technique: string, link: string, tick: number): SimEvent => ({
  k: "packet",
  tick,
  op: 0,
  technique,
  link,
  from: "a",
  to: "b",
  arriveTick: tick + 1,
});

/** Whether a hop at `tick` from a world with this seed is noticed. */
function noticed(
  seed: number,
  tick: number,
  technique: string,
  link: string,
  defenses: DefenseInstance[] = [],
): boolean {
  const world: World = { ...createWorld(network, seed), tick, defenses };
  const events = [packet(technique, link, tick)];
  stepDetect(world, index, events);
  return alertsOf(events).length > 0;
}

/** Ticks until the first noticed hop, starting at tick 1; 10000 when none is. */
function firstNoticed(seed: number, technique: string, link: string): number {
  for (let tick = 1; tick <= 10000; tick++) if (noticed(seed, tick, technique, link)) return tick;
  return 10000;
}

describe("the detection roll", () => {
  it("scales the signature by the sensor and then by what the link lets it read", () => {
    expect(detectionPermille(600, 1000, 1000)).toBe(600);
    expect(detectionPermille(600, 300, 1000)).toBe(180);
    expect(detectionPermille(600, 300, 250)).toBe(45);
    expect(detectionPermille(0, 1000, 1000)).toBe(0);
    expect(detectionPermille(1000, 1000, 0)).toBe(0);
  });

  it("gives every technique a signature, loudest for an exploit and quietest for a stolen account", () => {
    const sig = (id: string) => techniques.find((t) => t.id === id)?.signaturePermille ?? -1;
    for (const t of techniques) {
      expect(Number.isInteger(t.signaturePermille), t.id).toBe(true);
      expect(t.signaturePermille, t.id).toBeGreaterThanOrEqual(0);
      expect(t.signaturePermille, t.id).toBeLessThanOrEqual(1000);
    }
    // An exploit is loud, a genuine account and a vendor sign-in look like normal use.
    expect(sig("T0866")).toBeGreaterThan(sig("T0886"));
    expect(sig("T0886")).toBeGreaterThan(sig("T0822"));
    expect(sig("T0886")).toBeGreaterThan(sig("T0859"));
    // A technique that sends nothing has no hop for a sensor to see.
    expect(sig("T0840")).toBe(0);
  });

  it("is a pure function of the seed, the tick, the technique and the link", () => {
    for (let seed = 0; seed < 5; seed++) {
      for (let tick = 1; tick <= 200; tick++) {
        expect(noticed(seed, tick, "T0866", "l-dispatch-dmz")).toBe(
          noticed(seed, tick, "T0866", "l-dispatch-dmz"),
        );
      }
    }
  });
});

describe("loud techniques are detected sooner, quiet ones later", () => {
  const SEEDS = Array.from({ length: 24 }, (_, i) => i);
  const mean = (technique: string, link: string): number =>
    SEEDS.reduce((sum, seed) => sum + firstNoticed(seed, technique, link), 0) / SEEDS.length;

  // Each row is quieter than the one above it, on one and the same link.
  const table = [
    ["T0866", 600],
    ["T0886", 200],
    ["T0859", 100],
  ] as const;

  it("the louder the signature, the sooner the first alert, on average over the seed sample", () => {
    const times = table.map(([id]) => mean(id, "l-dispatch-dmz"));
    for (let i = 1; i < times.length; i++) {
      expect(times[i], `${table[i]?.[0]} vs ${table[i - 1]?.[0]}`).toBeGreaterThan(
        times[i - 1] ?? 0,
      );
    }
    // The same table twice gives the same numbers: nothing is random.
    expect(table.map(([id]) => mean(id, "l-dispatch-dmz"))).toEqual(times);
  });

  it("an encrypted vendor path is noticed later than a plain one, for the same technique", () => {
    const plain = mean("T0886", "l-dispatch-dmz");
    const tunnel = mean("T0886", "l-vpn-jump");
    expect(network.links.find((l) => l.id === "l-vpn-jump")?.visibilityPermille).toBeLessThan(1000);
    expect(tunnel).toBeGreaterThan(plain);
  });

  it("a sensor in force on the link makes it sooner, and one still being placed does not", () => {
    const sensor = (activeFrom: number): DefenseInstance => ({
      id: "d1",
      kind: "ids",
      link: "l-dispatch-dmz",
      conduit: "c-corp-dmz",
      direction: "",
      allow: [],
      placedAt: 0,
      activeFrom,
    });
    const rolls = (defenses: DefenseInstance[]): number => {
      let hits = 0;
      for (const seed of SEEDS) {
        for (let tick = 100; tick < 500; tick++) {
          if (noticed(seed, tick, "T0886", "l-dispatch-dmz", defenses)) hits++;
        }
      }
      return hits;
    };
    const bare = rolls([]);
    expect(rolls([sensor(0)])).toBeGreaterThan(bare * 2);
    expect(rolls([sensor(10_000)])).toBe(bare);
    // Adding a sensor adds alerts and never takes one away: same dice, higher chance.
    for (const seed of SEEDS) {
      for (let tick = 100; tick < 300; tick++) {
        if (noticed(seed, tick, "T0886", "l-dispatch-dmz")) {
          expect(noticed(seed, tick, "T0886", "l-dispatch-dmz", [sensor(0)])).toBe(true);
        }
      }
    }
  });
});

describe("the two clocks and the alerts on the phishing scenario", () => {
  const sensored = () => [...scenario.actions, ...sensorsOnChain()];
  const replay = () => run(warmWorld(index), index, sensored(), END);

  it("an alert fires, after the first action, and says what it saw and where", () => {
    const { world, events } = replay();
    const alerts = alertsOf(events);
    expect(alerts.length).toBeGreaterThan(0);
    expect(world.firstActionTick).toBe(scenario.actions[0]?.t);
    expect(world.detectedAt).toBeGreaterThan(world.firstActionTick);
    expect(world.detectedAt).toBe(alerts[0]?.tick);

    const first = alerts[0];
    expect(first).toMatchObject({ k: "ids.alert", legacyId: "" });
    expect(["T0865", "T0886"]).toContain(first?.technique);
    // The alert names the link of a hop that really happened this tick, and its conduit.
    const hops = events.filter((e) => e.k === "packet" && e.tick === first?.tick);
    expect(hops.map((e) => (e.k === "packet" ? e.link : ""))).toContain(first?.link);
    expect(first?.conduit).toBe(network.links.find((l) => l.id === first?.link)?.conduit ?? "");
  });

  it("the clocks and every alert reproduce exactly on a second replay from the same seed", () => {
    const a = replay();
    const b = replay();
    expect([b.world.firstActionTick, b.world.detectedAt]).toEqual([
      a.world.firstActionTick,
      a.world.detectedAt,
    ]);
    expect(alertsOf(b.events)).toEqual(alertsOf(a.events));
  });

  it("the first alert sets detectedAt once and later ones leave it alone", () => {
    const { world, events } = replay();
    const alerts = alertsOf(events);
    expect(world.detectedAt).toBe(Math.min(...alerts.map((e) => e.tick)));
  });

  it("names the sensor that saw it: a placed one once it is in force, the baseline elsewhere", () => {
    const { events } = replay();
    const covered = new Set(CHAIN_CONDUITS);
    // The three sensors are in force from this tick on.
    const allInForce = scenario.startTick + 2 + 2 + DEFENSE_PLACEMENT_LATENCY_TICKS;
    const alerts = alertsOf(events);
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      if (alert.tick < allInForce) expect(alert.sensor, `tick ${alert.tick}`).toBe("baseline");
      else if (covered.has(alert.conduit)) expect(alert.sensor).toMatch(/^d\d+$/);
      else expect(alert.sensor).toBe("baseline");
    }
  });

  it("without the attacker there is nothing to detect and both clocks stay at zero", () => {
    const { world, events } = run(warmWorld(index), index, [], scenario.startTick + 300);
    expect(alertsOf(events)).toEqual([]);
    expect([world.firstActionTick, world.detectedAt]).toEqual([0, 0]);
  });

  it("reports a technique under its current ID and, when it has one, its old one", () => {
    // T1692.001 was T0855 before the restructuring. Walk the ticks to the first noticed hop.
    const world: World = createWorld(network, 0);
    let alert: Alert | undefined;
    for (let tick = 1; tick < 5000 && alert === undefined; tick++) {
      world.tick = tick;
      const events: SimEvent[] = [packet("T1692.001", "l-fep-tav", tick)];
      stepDetect(world, index, events);
      alert = alertsOf(events)[0];
    }
    expect(alert).toMatchObject({
      technique: "T1692.001",
      legacyId: "T0855",
      conduit: "c-ctrl-tav",
    });
  });
});

describe("a counterfactual replay", () => {
  const warm = () => warmWorld(index);
  const launch = scenario.actions;
  const firewall: TimedAction = {
    t: scenario.startTick + 5,
    a: { type: "defense.place", kind: "firewall", on: { conduit: "c-dmz-ctrl" } },
  };

  it("with a firewall added, propagation stops where the undefended run went on", () => {
    const { undefended, defended } = counterfactual(warm(), index, launch, END, [firewall]);
    expect(undefended.commandChannelLost).toContain("tms-server");
    expect(defended.commandChannelLost).toEqual([]);
    expect(defended.compromised.length).toBeLessThan(undefended.compromised.length + 1);
    expect(defended.compromised).not.toContain("dispatch-hmi-1");
    expect(defended.refused).toBeGreaterThan(undefended.refused);
    expect(defended.hash).not.toBe(undefended.hash);
  });

  it("with a sensor added, the alert comes sooner, or at all where there was none", () => {
    const { undefended, defended } = counterfactual(warm(), index, launch, END, sensorsOnChain());
    expect(defended.alerts).toBeGreaterThan(0);
    expect(defended.detectedAt).toBeGreaterThan(defended.firstActionTick);
    expect(undefended.detectedAt === 0 || defended.detectedAt < undefended.detectedAt).toBe(true);
    expect(defended.hash).not.toBe(undefended.hash);
  });

  it("the defended run is deterministic: the same seed and actions give the same hash again", () => {
    const first = counterfactual(warm(), index, launch, END, [firewall, ...sensorsOnChain()]);
    const second = counterfactual(warm(), index, launch, END, [firewall, ...sensorsOnChain()]);
    expect(second).toEqual(first);
    // And it is the undefended run's own hash when there is nothing to add.
    expect(counterfactual(warm(), index, launch, END, []).defended).toEqual(first.undefended);
  });

  it("a sensor only adds: over a sample of seeds it never loses or delays an alert", () => {
    for (const seed of [0, 1, 4, 6, 21, 25, 35]) {
      const start = run(createWorld(network, seed), index, [], scenario.startTick).world;
      const { undefended, defended } = counterfactual(
        start,
        index,
        launch,
        scenario.startTick + 400,
        sensorsOnChain(),
      );
      expect(defended.alerts, `seed ${seed}`).toBeGreaterThanOrEqual(undefended.alerts);
      if (undefended.detectedAt !== 0) {
        expect(defended.detectedAt, `seed ${seed}`).toBeLessThanOrEqual(undefended.detectedAt);
      }
      // A sensor restricts nothing: what the attacker achieved is untouched.
      expect(defended.commandChannelLost, `seed ${seed}`).toEqual(undefended.commandChannelLost);
      expect(defended.compromised, `seed ${seed}`).toEqual(undefended.compromised);
    }
  }, 60_000);

  it("runOutcome reports the same hash for the same inputs, and the placement delay is in it", () => {
    const a = runOutcome(warm(), index, launch, END);
    const b = runOutcome(warm(), index, launch, END);
    expect(b).toEqual(a);
    expect(DEFENSE_PLACEMENT_LATENCY_TICKS).toBeGreaterThan(0);
  });
});

describe("detection cannot reach the railway", () => {
  const code = (path: string): string =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  const fields = (source: string, pattern: RegExp): string[] =>
    [...new Set([...source.matchAll(pattern)].map((m) => m[1] ?? ""))].sort();

  it("reads the clock, the dice seed and the defenses, and writes only its two clock fields", () => {
    const source = code("src/core/detect/ids.ts");
    expect(fields(source, /\bworld\.(\w+)/g)).toEqual([
      "defenses",
      "detectedAt",
      "firstActionTick",
      "seed",
      "tick",
    ]);
    expect(fields(source, /\bworld\.(\w+)\s*(?:=|\+=|-=)(?!=)/g)).toEqual([
      "detectedAt",
      "firstActionTick",
    ]);
  });

  it("leaves the railway exactly as it was: trains, points and interlockings match a run without sensors", () => {
    const bare = run(warmWorld(index), index, scenario.actions, END).world;
    const watched = run(
      warmWorld(index),
      index,
      [...scenario.actions, ...sensorsOnChain()],
      END,
    ).world;
    expect(watched.trains).toEqual(bare.trains);
    expect(watched.points).toEqual(bare.points);
    expect(watched.interlockings).toEqual(bare.interlockings);
    expect(watched.nodes).toEqual(bare.nodes);
  });
});

describe("what the content must say about detection", () => {
  const problems = (run: () => void): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof ContentError) return error.problems.join(" ");
      throw error;
    }
    return "";
  };
  const base = techniques[0];

  it("rejects a signature outside 0..1000 permille", () => {
    if (base === undefined) throw new Error("no technique");
    for (const bad of [-1, 1001, 99.5]) {
      expect(
        problems(() => validateTechniques([{ ...base, signaturePermille: bad }], network)),
      ).toMatch(/signaturePermille/);
    }
  });

  it("rejects a link visibility outside 0..1000 permille", () => {
    const content: Content = {
      ...network,
      links: network.links.map((l) =>
        l.id === "l-vpn-jump" ? { ...l, visibilityPermille: 1500 } : l,
      ),
    };
    expect(problems(() => validateContent(content))).toMatch(/visibilityPermille/);
  });

  it("accepts the committed content", () => {
    expect(problems(() => validateContent(network))).toBe("");
    expect(problems(() => validateTechniques(techniques, network))).toBe("");
  });
});
