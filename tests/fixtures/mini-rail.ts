import type { Content } from "../../src/content/types";
import { tinyTopology } from "./tiny-topology";

/**
 * One line segment: block A, block B, block C in a row, two signals, one
 * interlocking, one service. Small enough to reason about by hand:
 *
 *   A (500 m) --S-A--> B (1200 m) --S-B--> C (500 m, terminal)
 *
 * The path is 22000 dm long; S-A stands at 5000 dm and S-B at 17000 dm.
 */
export const miniRail: Content = {
  ...tinyTopology,
  nodes: [
    ...tinyTopology.nodes,
    {
      id: "oc-1",
      kind: "object-controller",
      zone: "ctl",
      label: "Object controller OC-1",
      roles: [],
      tags: [],
      hardeningPermille: 300,
      controls: "IL-1",
    },
  ],
  links: [
    ...tinyTopology.links,
    { id: "l-il-oc", a: "il-1-ctl", b: "oc-1", protocols: ["safety-comms"], latencyTicks: 2 },
  ],
  tracks: {
    vmaxDmPerTick: 33,
    blocks: [
      { id: "A", section: "sec-A", lengthDm: 5000, next: ["B"], controller: "oc-1" },
      { id: "B", section: "sec-B", lengthDm: 12000, next: ["C"], controller: "oc-1" },
      { id: "C", section: "sec-C", lengthDm: 5000, next: [], controller: "oc-1" },
    ],
    points: [],
    signals: [
      {
        id: "S-A",
        block: "A",
        atDm: 5000,
        controller: "oc-1",
        interlocking: "IL-1",
        overlapDm: 3600,
      },
      {
        id: "S-B",
        block: "B",
        atDm: 12000,
        controller: "oc-1",
        interlocking: "IL-1",
        overlapDm: 3600,
      },
    ],
    routes: [
      {
        id: "R-A",
        interlocking: "IL-1",
        entrySignal: "S-A",
        blocks: ["B"],
        points: [],
        overlap: ["C"],
      },
      {
        id: "R-B",
        interlocking: "IL-1",
        entrySignal: "S-B",
        blocks: ["C"],
        points: [],
        overlap: [],
      },
    ],
    services: [
      {
        id: "SV-1",
        path: ["A", "B", "C"],
        stops: [],
        firstTick: 1,
        headwayTicks: 100000,
        count: 1,
      },
    ],
  },
};
