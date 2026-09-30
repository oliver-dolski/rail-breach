import { EMERGENCY_BRAKE_PERIOD_TICKS } from "../sim/constants";
import type { Index } from "../sim/model";
import type { World } from "../sim/world";
import { deriveAspect, isRestrictive } from "./interlocking";
import { stopDistance } from "./kinematics";
import { hardConflict, routeStillProved } from "./routes";
import { computeOccupancy, OCCUPIED, trainSections } from "./trackGraph";

export class InvariantViolation extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`safety invariant violated:\n- ${violations.join("\n- ")}`);
    this.name = "InvariantViolation";
  }
}

/**
 * Every way the safety rules can currently be broken, in plain words. Empty
 * means the invariant holds. Read-only: the UI can poll this each frame.
 *
 *  1 no two trains occupy one section
 *  2 no train has gone beyond the far end of its authority: the front is never
 *    past a signal it has not been let through (pointer consistency), and a
 *    train can always still stop short of the end of the overlap of the first
 *    signal ahead that is not permissive, using emergency braking
 *  3 no signal shows proceed or caution without a locked, unused, proved route
 *    on a healthy interlocking
 *  4 held routes never conflict, and their points are commanded into position
 *  5 no point moves while a train stands in its zone
 */
export function findViolations(world: World, index: Index): string[] {
  const out: string[] = [];
  const { graph, routes } = index.rail;
  const occ = computeOccupancy(world, graph);

  // 1 - double occupancy
  const owners: string[][] = graph.sections.map(() => []);
  for (const train of world.trains) {
    for (const s of trainSections(train, graph)) owners[s]?.push(train.id);
  }
  owners.forEach((who, s) => {
    if (who.length > 1) out.push(`section ${graph.sections[s]} holds ${who.join(" and ")}`);
  });

  // 2 - authority
  const nextTick = world.tick + 1;
  for (const train of world.trains) {
    const geometry = graph.services.get(train.service);
    if (!geometry) continue;
    const head = train.posDm;

    geometry.sigs.forEach((ps, j) => {
      const passed = j < train.sig;
      if (passed && head <= ps.posDm) {
        out.push(`${train.id} is marked past ${ps.signal.id} but its front is short of it`);
      }
      if (!passed && head > ps.posDm) {
        out.push(`${train.id} is past ${ps.signal.id} without having been let through`);
      }
    });

    let end = geometry.lengthDm;
    let by = "the end of its path";
    if (train.overrun >= 0) {
      const ps = geometry.sigs[train.overrun];
      if (ps) {
        end = ps.posDm + ps.signal.overlapDm;
        by = `the overlap of ${ps.signal.id}`;
      }
    } else {
      for (let j = train.sig; j < geometry.sigs.length; j++) {
        const ps = geometry.sigs[j];
        if (ps && isRestrictive(deriveAspect(ps.signal, world, index, occ))) {
          end = ps.posDm + ps.signal.overlapDm;
          by = `the overlap of ${ps.signal.id}`;
          break;
        }
      }
    }
    const reach = head + stopDistance(train.speedDmPerTick, nextTick, EMERGENCY_BRAKE_PERIOD_TICKS);
    if (reach > end) {
      out.push(`${train.id} cannot stop short of ${by}: it would reach ${reach}, limit ${end}`);
    }
  }

  // 3 - aspects
  for (const signal of graph.signals) {
    const aspect = deriveAspect(signal, world, index, occ);
    if (isRestrictive(aspect)) continue;
    const il = world.interlockings.find((i) => i.id === signal.interlocking);
    const lock = il?.locks.find((l) => routes.byId.get(l.route)?.entry.id === signal.id);
    const route = lock === undefined ? undefined : routes.byId.get(lock.route);
    if (il?.health !== "ok" || lock === undefined || route === undefined) {
      out.push(`${signal.id} shows ${aspect} without a locked route on a healthy interlocking`);
    } else if (lock.used || !routeStillProved(world, route, occ)) {
      out.push(`${signal.id} shows ${aspect} but route ${lock.route} is not proved`);
    }
  }

  // 4 - locks
  const held = world.interlockings.flatMap((il) => il.locks);
  for (const lock of held) {
    const route = routes.byId.get(lock.route);
    if (!route) {
      out.push(`lock names unknown route ${lock.route}`);
      continue;
    }
    for (const want of route.def.points) {
      const point = world.points.find((p) => p.id === want.point);
      if (!point || point.target !== want.pos) {
        out.push(
          `route ${lock.route} is locked but point ${want.point} is not commanded ${want.pos}`,
        );
      }
    }
  }
  for (let a = 0; a < held.length; a++) {
    for (let b = a + 1; b < held.length; b++) {
      const ra = routes.byId.get(held[a]?.route ?? "");
      const rb = routes.byId.get(held[b]?.route ?? "");
      if (ra && rb && hardConflict(ra, rb)) {
        out.push(`locked routes ${ra.def.id} and ${rb.def.id} conflict`);
      }
    }
  }

  // 5 - points
  for (const point of world.points) {
    if (point.moving === 0 && point.pos === point.target) continue;
    const zone = graph.points.get(point.id)?.zone ?? [];
    for (const id of zone) {
      const s = graph.sectionIx.get(id);
      if (s !== undefined && occ[s] === OCCUPIED) {
        out.push(`point ${point.id} is moving while section ${id} is occupied`);
      }
    }
  }
  return out;
}

export function assertInvariants(world: World, index: Index): void {
  const violations = findViolations(world, index);
  if (violations.length > 0) throw new InvariantViolation(violations);
}
