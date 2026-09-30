import type { Content } from "../../src/content/types";

/** Minimal valid 3-node topology: internet -> corporate workstation -> interlocking. */
export const tinyTopology: Content = {
  zones: [
    { id: "ext", name: "Internet", purdue: "ext", slTarget: 1 },
    { id: "corp", name: "Corporate", purdue: 4, slTarget: 2 },
    { id: "ctl", name: "Control", purdue: 2, slTarget: 3 },
  ],
  nodes: [
    {
      id: "internet",
      kind: "external",
      zone: "ext",
      label: "Internet",
      roles: [],
      tags: [],
      hardeningPermille: 0,
    },
    {
      id: "corp-ws",
      kind: "corp-workstation",
      zone: "corp",
      label: "Dispatcher workstation",
      roles: ["dispatcher-ws"],
      tags: ["unpatched"],
      hardeningPermille: 100,
      awarenessPermille: 400,
    },
    {
      id: "il-1-ctl",
      kind: "interlocking",
      zone: "ctl",
      label: "Interlocking IL-1",
      roles: [],
      tags: [],
      hardeningPermille: 500,
      controls: "IL-1",
    },
  ],
  links: [
    {
      id: "l-ext-corp",
      a: "internet",
      b: "corp-ws",
      protocols: ["smtp"],
      latencyTicks: 5,
      conduit: "c-ext-corp",
    },
    {
      id: "l-corp-ctl",
      a: "corp-ws",
      b: "il-1-ctl",
      protocols: ["remote-services"],
      latencyTicks: 3,
      conduit: "c-corp-ctl",
    },
  ],
  conduits: [
    { id: "c-ext-corp", zoneA: "ext", zoneB: "corp", name: "Internet to corporate" },
    { id: "c-corp-ctl", zoneA: "corp", zoneB: "ctl", name: "Corporate to control" },
  ],
  interlockings: [{ id: "IL-1", label: "Interlocking IL-1" }],
  trains: [{ id: "TR-1", startPosDm: 0 }],
};
