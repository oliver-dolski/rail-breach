import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { deriveRailInputs, neutralInputs } from "../../../src/core/rail/inputs";
import { deriveAspects } from "../../../src/core/rail/interlocking";
import type { Action } from "../../../src/core/sim/actions";
import type { SimEvent } from "../../../src/core/sim/events";
import { buildIndex } from "../../../src/core/sim/model";
import { step } from "../../../src/core/sim/step";
import { createWorld, type World } from "../../../src/core/sim/world";

const index = buildIndex(network);
const SEED = 3;

const routes = index.rail.routes.routes;
const here = routes[0];
const elsewhere = routes.find((r) => r.il !== here?.il);
if (here === undefined || elsewhere === undefined) throw new Error("network has too few routes");

const request = (route: string): Action => ({ type: "route.request", route });
const cancel = (route: string): Action => ({ type: "route.cancel", route });

function node(world: World, id: string) {
  const found = world.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

/** The node that controls an interlocking (the interlocking's own machine). */
function controllerOf(il: string): string {
  const found = network.nodes.find((n) => n.kind === "interlocking" && n.controls === il);
  if (!found) throw new Error(`no node controls ${il}`);
  return found.id;
}

/** One tick with `actions`, and what the interlockings said about requests in it. */
function tick(world: World, actions: Action[]): { world: World; events: SimEvent[] } {
  const result = step(world, actions, index);
  return { world: result.world, events: result.events };
}

const rejections = (events: SimEvent[]) =>
  events.flatMap((e) => (e.k === "command.rejected" ? [e] : []));
const sets = (events: SimEvent[]) => events.flatMap((e) => (e.k === "route.set" ? [e] : []));

describe("denial of control reaches the railway", () => {
  it("lets an operator set a route when nothing is denied (the baseline)", () => {
    const { events } = tick(createWorld(network, SEED), [request(here.def.id)]);
    expect(sets(events).map((e) => e.route)).toContain(here.def.id);
    expect(rejections(events)).toEqual([]);
  });

  it("refuses an operator request while the traffic management server is denied control, and says why", () => {
    const world = createWorld(network, SEED);
    node(world, "tms-server").controlDenied = true;
    const { world: after, events } = tick(world, [request(here.def.id)]);
    expect(sets(events)).toEqual([]);
    expect(rejections(events)).toEqual([
      expect.objectContaining({
        il: here.il,
        route: here.def.id,
        by: "operator",
        reason: "control denied",
      }),
    ]);
    expect(after.interlockings.every((il) => il.locks.every((l) => l.route !== here.def.id))).toBe(
      true,
    );
  });

  it("refuses an operator cancel too: the operators cannot steer, either way", () => {
    let world = createWorld(network, SEED);
    world = tick(world, [request(here.def.id)]).world;
    expect(world.interlockings.some((il) => il.locks.some((l) => l.route === here.def.id))).toBe(
      true,
    );
    node(world, "tms-server").controlDenied = true;
    const { world: after, events } = tick(world, [cancel(here.def.id)]);
    expect(rejections(events).map((r) => r.reason)).toEqual(["control denied"]);
    expect(after.interlockings.some((il) => il.locks.some((l) => l.route === here.def.id))).toBe(
      true,
    );
  });

  it("denies only the interlocking whose own controls are denied", () => {
    const world = createWorld(network, SEED);
    node(world, controllerOf(here.il)).controlDenied = true;
    const { events } = tick(world, [request(here.def.id), request(elsewhere.def.id)]);
    expect(rejections(events).map((r) => r.route)).toEqual([here.def.id]);
    expect(sets(events).map((e) => e.route)).toEqual([elsewhere.def.id]);
  });

  it("accepts requests again once the denial lifts", () => {
    let world = createWorld(network, SEED);
    node(world, "tms-server").controlDenied = true;
    world = tick(world, [request(here.def.id)]).world;
    node(world, "tms-server").controlDenied = false;
    const { events } = tick(world, [request(here.def.id)]);
    expect(sets(events).map((e) => e.route)).toContain(here.def.id);
  });

  it("leaves the dispatch layer, the routes already set and every aspect alone", () => {
    const base = createWorld(network, SEED);
    const denied = createWorld(network, SEED);
    node(denied, "tms-server").controlDenied = true;
    let a = base;
    let b = denied;
    const eventsA: SimEvent[] = [];
    const eventsB: SimEvent[] = [];
    for (let i = 0; i < 600; i++) {
      const ra = tick(a, []);
      const rb = tick(b, []);
      a = ra.world;
      b = rb.world;
      eventsA.push(...ra.events);
      eventsB.push(...rb.events);
    }
    // Same railway, tick for tick: only the operators' requests are refused, and none were made.
    expect(eventsB).toEqual(eventsA);
    expect(deriveAspects(b, index)).toEqual(deriveAspects(a, index));
    expect(sets(eventsB).length).toBeGreaterThan(0);
    expect(sets(eventsB).every((e) => e.by === "ctc")).toBe(true);
  });

  it("is a flag per interlocking in the rail inputs, and only ever refuses", () => {
    const world = createWorld(network, SEED);
    expect(deriveRailInputs(world, index)).toEqual(neutralInputs(world));
    node(world, "tms-server").controlDenied = true;
    const all = deriveRailInputs(world, index);
    expect(Object.values(all.controlDenied).every(Boolean)).toBe(true);
    // Nothing else moves: the same health, channel, sections, signals and caps as neutral.
    expect({ ...all, controlDenied: {} }).toEqual({
      ...neutralInputs(world),
      controlDenied: {},
    });
  });
});
