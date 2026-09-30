import type { BlockDef, PointDef, RouteDef, ServiceDef, SignalDef, TrackContent } from "./types";

/**
 * The fictional track: a double-track main line with a single-track branch,
 * west to east
 *
 *   Harkwell - Tavershall - Velmoor Junction - Crenmoor - Dunmarrow
 *                                  \
 *                                   +- (single track) - Pellthorne
 *
 * Blocks are directed, so the two main tracks are separate chains ("dn" runs
 * west to east, "up" east to west) and can never meet head-on. Only the branch
 * is used both ways: its two directed blocks share one axle-counter section, so
 * the interlocking cannot send trains into it from both ends. Station blocks are
 * 500 m, line blocks are 1.5 to 2.4 km; every signal stands at the far end of its
 * block and every route runs over exactly one block.
 *
 * Lengths are decimetres, speeds decimetres per tick (33 is about 119 km/h).
 * Every overlap is 360 m, above the emergency braking distance at line speed.
 */

const OVERLAP_DM = 3600;

type Il = "IL-TAV" | "IL-VEL" | "IL-CRE";
type Oc = "oc-tav" | "oc-vel" | "oc-cre";
const OC: Record<Il, Oc> = { "IL-TAV": "oc-tav", "IL-VEL": "oc-vel", "IL-CRE": "oc-cre" };

const block = (
  id: string,
  lengthDm: number,
  next: string[],
  il: Il,
  section: string = `sec-${id}`,
): BlockDef => ({ id, section, lengthDm, next, controller: OC[il] });

const signal = (id: string, blockId: string, lengthDm: number, il: Il): SignalDef => ({
  id,
  block: blockId,
  atDm: lengthDm,
  controller: OC[il],
  interlocking: il,
  overlapDm: OVERLAP_DM,
});

const route = (
  id: string,
  il: Il,
  entrySignal: string,
  blocks: string[],
  overlap: string[],
  points: RouteDef["points"] = [],
): RouteDef => ({ id, interlocking: il, entrySignal, blocks, points, overlap });

export const blocks: BlockDef[] = [
  // Down line (west to east)
  block("HAR_dn", 5000, ["L1_dn"], "IL-TAV"),
  block("L1_dn", 24000, ["TAV_dn"], "IL-TAV"),
  block("TAV_dn", 5000, ["L2_dn"], "IL-TAV"),
  block("L2_dn", 21000, ["VEL_dn"], "IL-VEL"),
  block("VEL_dn", 5000, ["L3_dn", "BR_dn"], "IL-VEL"),
  block("L3_dn", 18000, ["CRE_dn"], "IL-CRE"),
  block("CRE_dn", 5000, ["L4_dn"], "IL-CRE"),
  block("L4_dn", 22000, ["DUN_dn"], "IL-CRE"),
  block("DUN_dn", 5000, [], "IL-CRE"),
  // Up line (east to west)
  block("DUN_up", 5000, ["L4_up"], "IL-CRE"),
  block("L4_up", 22000, ["CRE_up"], "IL-CRE"),
  block("CRE_up", 5000, ["L3_up"], "IL-CRE"),
  block("L3_up", 18000, ["VEL_up"], "IL-VEL"),
  block("VEL_up", 5000, ["L2_up"], "IL-VEL"),
  block("L2_up", 21000, ["TAV_up"], "IL-TAV"),
  block("TAV_up", 5000, ["L1_up"], "IL-TAV"),
  block("L1_up", 24000, ["HAR_up"], "IL-TAV"),
  block("HAR_up", 5000, [], "IL-TAV"),
  // Single-track branch: each stretch is two directed blocks in one section
  block("BR_dn", 16000, ["PEL_dn"], "IL-VEL", "sec-BR"),
  block("PEL_dn", 5000, [], "IL-VEL", "sec-PEL"),
  block("PEL_up", 5000, ["BR_up"], "IL-VEL", "sec-PEL"),
  block("BR_up", 16000, ["VEL_up"], "IL-VEL", "sec-BR"),
];

export const signals: SignalDef[] = [
  signal("S-HAR-dn", "HAR_dn", 5000, "IL-TAV"),
  signal("S-L1-dn", "L1_dn", 24000, "IL-TAV"),
  signal("S-TAV-dn", "TAV_dn", 5000, "IL-TAV"),
  signal("S-L2-dn", "L2_dn", 21000, "IL-VEL"),
  signal("S-VEL-dn", "VEL_dn", 5000, "IL-VEL"),
  signal("S-L3-dn", "L3_dn", 18000, "IL-CRE"),
  signal("S-CRE-dn", "CRE_dn", 5000, "IL-CRE"),
  signal("S-L4-dn", "L4_dn", 22000, "IL-CRE"),
  signal("S-BR-dn", "BR_dn", 16000, "IL-VEL"),
  signal("S-DUN-up", "DUN_up", 5000, "IL-CRE"),
  signal("S-L4-up", "L4_up", 22000, "IL-CRE"),
  signal("S-CRE-up", "CRE_up", 5000, "IL-CRE"),
  signal("S-L3-up", "L3_up", 18000, "IL-VEL"),
  signal("S-VEL-up", "VEL_up", 5000, "IL-VEL"),
  signal("S-L2-up", "L2_up", 21000, "IL-TAV"),
  signal("S-TAV-up", "TAV_up", 5000, "IL-TAV"),
  signal("S-L1-up", "L1_up", 24000, "IL-TAV"),
  signal("S-PEL-up", "PEL_up", 5000, "IL-VEL"),
  signal("S-BR-up", "BR_up", 16000, "IL-VEL"),
];

/**
 * J1 diverges the down line onto the branch (facing points). J2 joins the
 * branch to the up line (trailing points). The branch dives under the main lines
 * so the two junctions never cross on the flat.
 */
export const points: PointDef[] = [
  {
    id: "J1",
    interlocking: "IL-VEL",
    controller: "oc-vel",
    movingTicks: 60,
    toe: "VEL_dn",
    normal: "L3_dn",
    reverse: "BR_dn",
    zone: ["sec-L3_dn", "sec-BR"],
  },
  {
    id: "J2",
    interlocking: "IL-VEL",
    controller: "oc-vel",
    movingTicks: 60,
    toe: "VEL_up",
    normal: "L3_up",
    reverse: "BR_up",
    zone: ["sec-VEL_up"],
  },
];

export const routes: RouteDef[] = [
  route("R-HAR-dn", "IL-TAV", "S-HAR-dn", ["L1_dn"], ["TAV_dn"]),
  route("R-L1-dn", "IL-TAV", "S-L1-dn", ["TAV_dn"], ["L2_dn"]),
  route("R-TAV-dn", "IL-TAV", "S-TAV-dn", ["L2_dn"], ["VEL_dn"]),
  route("R-L2-dn", "IL-VEL", "S-L2-dn", ["VEL_dn"], ["L3_dn", "BR_dn"]),
  route(
    "R-VEL-dn-main",
    "IL-VEL",
    "S-VEL-dn",
    ["L3_dn"],
    ["CRE_dn"],
    [{ point: "J1", pos: "normal" }],
  ),
  route(
    "R-VEL-dn-br",
    "IL-VEL",
    "S-VEL-dn",
    ["BR_dn"],
    ["PEL_dn"],
    [{ point: "J1", pos: "reverse" }],
  ),
  route("R-L3-dn", "IL-CRE", "S-L3-dn", ["CRE_dn"], ["L4_dn"]),
  route("R-CRE-dn", "IL-CRE", "S-CRE-dn", ["L4_dn"], ["DUN_dn"]),
  route("R-L4-dn", "IL-CRE", "S-L4-dn", ["DUN_dn"], []),
  route("R-BR-dn", "IL-VEL", "S-BR-dn", ["PEL_dn"], []),
  route("R-DUN-up", "IL-CRE", "S-DUN-up", ["L4_up"], ["CRE_up"]),
  route("R-L4-up", "IL-CRE", "S-L4-up", ["CRE_up"], ["L3_up"]),
  route("R-CRE-up", "IL-CRE", "S-CRE-up", ["L3_up"], ["VEL_up"]),
  route("R-L3-up", "IL-VEL", "S-L3-up", ["VEL_up"], ["L2_up"], [{ point: "J2", pos: "normal" }]),
  route("R-BR-up", "IL-VEL", "S-BR-up", ["VEL_up"], ["L2_up"], [{ point: "J2", pos: "reverse" }]),
  route("R-VEL-up", "IL-VEL", "S-VEL-up", ["L2_up"], ["TAV_up"]),
  route("R-L2-up", "IL-TAV", "S-L2-up", ["TAV_up"], ["L1_up"]),
  route("R-TAV-up", "IL-TAV", "S-TAV-up", ["L1_up"], ["HAR_up"]),
  route("R-L1-up", "IL-TAV", "S-L1-up", ["HAR_up"], []),
  route("R-PEL-up", "IL-VEL", "S-PEL-up", ["BR_up"], ["VEL_up"]),
];

const DWELL_TICKS = 300;

/**
 * Fixed timetable. Times are ticks (10 per second), so 3600 ticks is a
 * departure every six minutes on each main-line direction and one branch train
 * each way every twelve minutes, spaced so the branch is never asked to carry
 * two trains towards each other.
 */
export const services: ServiceDef[] = [
  {
    id: "SV-DN",
    path: ["HAR_dn", "L1_dn", "TAV_dn", "L2_dn", "VEL_dn", "L3_dn", "CRE_dn", "L4_dn", "DUN_dn"],
    stops: [
      { block: "TAV_dn", dwellTicks: DWELL_TICKS },
      { block: "VEL_dn", dwellTicks: DWELL_TICKS },
      { block: "CRE_dn", dwellTicks: DWELL_TICKS },
    ],
    firstTick: 100,
    headwayTicks: 3600,
    count: 40,
  },
  {
    id: "SV-UP",
    path: ["DUN_up", "L4_up", "CRE_up", "L3_up", "VEL_up", "L2_up", "TAV_up", "L1_up", "HAR_up"],
    stops: [
      { block: "CRE_up", dwellTicks: DWELL_TICKS },
      { block: "VEL_up", dwellTicks: DWELL_TICKS },
      { block: "TAV_up", dwellTicks: DWELL_TICKS },
    ],
    firstTick: 1800,
    headwayTicks: 3600,
    count: 40,
  },
  {
    id: "SV-BR-DN",
    path: ["HAR_dn", "L1_dn", "TAV_dn", "L2_dn", "VEL_dn", "BR_dn", "PEL_dn"],
    stops: [
      { block: "TAV_dn", dwellTicks: DWELL_TICKS },
      { block: "VEL_dn", dwellTicks: DWELL_TICKS },
    ],
    firstTick: 2000,
    headwayTicks: 7200,
    count: 20,
  },
  {
    id: "SV-BR-UP",
    path: ["PEL_up", "BR_up", "VEL_up", "L2_up", "TAV_up", "L1_up", "HAR_up"],
    stops: [
      { block: "VEL_up", dwellTicks: DWELL_TICKS },
      { block: "TAV_up", dwellTicks: DWELL_TICKS },
    ],
    firstTick: 6600,
    headwayTicks: 7200,
    count: 20,
  },
];

export const tracks: TrackContent = {
  vmaxDmPerTick: 33,
  blocks,
  points,
  signals,
  routes,
  services,
};
