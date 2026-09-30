import type { ConduitDef, Content, LinkDef, NodeDef, Zone } from "./types";

/**
 * The cyber side of the fictional railway: which machines exist, how they are
 * wired and where the zone boundaries run. Every name is invented; no address
 * is given at all, so nothing here can be mistaken for a real network.
 *
 * Fictional geography, west to east on the main line:
 *   Harkwell - Tavershall - Velmoor Junction - Crenmoor - Dunmarrow
 * with a single-track branch from Velmoor Junction to Pellthorne.
 *
 * Three interlockings (Tavershall, Velmoor Junction, Crenmoor) each work with
 * one object controller that drives the lineside signals and evaluates the
 * axle counters. Trackside objects are never networked directly.
 *
 * The posture is deliberately weak in places (permissive remote-services
 * conduits, unpatched hosts) so the attack works in the default demo; the
 * defense mode is what tightens it.
 */

export const zones: Zone[] = [
  { id: "z-internet", name: "Internet", purdue: "ext", slTarget: 1 },
  { id: "z-corp", name: "Corporate IT", purdue: 4, slTarget: 2 },
  { id: "z-vendor", name: "Vendor access (untrusted)", purdue: 5, slTarget: 1 },
  { id: "z-dmz", name: "DMZ", purdue: 3.5, slTarget: 3 },
  { id: "z-ctrl", name: "Control centre", purdue: 3, slTarget: 3 },
  { id: "z-il-tav", name: "Interlocking Tavershall", purdue: 2, slTarget: 4 },
  { id: "z-il-vel", name: "Interlocking Velmoor Junction", purdue: 2, slTarget: 4 },
  { id: "z-il-cre", name: "Interlocking Crenmoor", purdue: 2, slTarget: 4 },
  { id: "z-way", name: "Trackside", purdue: 1, slTarget: 3 },
];

const interlockingNode = (id: string, zone: string, station: string, il: string): NodeDef => ({
  id,
  kind: "interlocking",
  zone,
  label: `Interlocking ${station}`,
  roles: [],
  tags: [],
  hardeningPermille: 700,
  controls: il,
});

const maintenanceNode = (id: string, zone: string, station: string): NodeDef => ({
  id,
  kind: "engineering-ws",
  zone,
  label: `Signal box maintenance workstation (${station})`,
  roles: ["signal-box-ws"],
  tags: ["unpatched"],
  hardeningPermille: 250,
});

const objectControllerNode = (id: string, station: string, il: string): NodeDef => ({
  id,
  kind: "object-controller",
  zone: "z-way",
  label: `Object controller ${station}`,
  roles: [],
  tags: [],
  hardeningPermille: 600,
  controls: il,
});

export const nodes: NodeDef[] = [
  {
    id: "internet",
    kind: "external",
    zone: "z-internet",
    label: "Internet",
    roles: [],
    tags: [],
    hardeningPermille: 0,
  },
  {
    id: "corp-mail",
    kind: "mail-server",
    zone: "z-corp",
    label: "Corporate mail gateway",
    roles: ["mail"],
    tags: [],
    hardeningPermille: 300,
  },
  {
    id: "corp-dc",
    kind: "domain-controller",
    zone: "z-corp",
    label: "Corporate directory server",
    roles: ["directory"],
    tags: [],
    hardeningPermille: 400,
  },
  {
    id: "corp-ws-dispatch",
    kind: "corp-workstation",
    zone: "z-corp",
    label: "Dispatcher office workstation",
    roles: ["dispatcher-ws"],
    tags: ["unpatched"],
    hardeningPermille: 100,
    awarenessPermille: 400,
  },
  {
    id: "corp-ws-office",
    kind: "corp-workstation",
    zone: "z-corp",
    label: "Back-office workstation",
    roles: ["office-ws"],
    tags: [],
    hardeningPermille: 250,
    awarenessPermille: 550,
  },
  {
    id: "vpn-gw",
    kind: "vpn-gateway",
    zone: "z-vendor",
    label: "Vendor VPN gateway",
    roles: ["vendor-access"],
    tags: ["remote-enabled"],
    hardeningPermille: 350,
  },
  {
    id: "vendor-jump",
    kind: "vendor-jump-host",
    zone: "z-vendor",
    label: "Vendor jump host",
    roles: ["vendor-access"],
    tags: ["remote-enabled", "unpatched"],
    hardeningPermille: 200,
  },
  {
    id: "dmz-relay",
    kind: "dmz-relay",
    zone: "z-dmz",
    label: "DMZ relay (patch distribution and historian mirror)",
    roles: ["relay"],
    tags: [],
    hardeningPermille: 450,
  },
  {
    id: "tms-server",
    kind: "scada-server",
    zone: "z-ctrl",
    label: "Traffic management server",
    roles: ["traffic-management"],
    tags: ["has-cmd-channel"],
    hardeningPermille: 400,
  },
  {
    id: "dispatch-hmi-1",
    kind: "hmi",
    zone: "z-ctrl",
    label: "Dispatcher console 1",
    roles: ["dispatcher-hmi"],
    tags: ["has-cmd-channel", "unpatched"],
    hardeningPermille: 200,
  },
  {
    id: "dispatch-hmi-2",
    kind: "hmi",
    zone: "z-ctrl",
    label: "Dispatcher console 2",
    roles: ["dispatcher-hmi"],
    tags: ["has-cmd-channel"],
    hardeningPermille: 300,
  },
  {
    id: "ctrl-eng-ws",
    kind: "engineering-ws",
    zone: "z-ctrl",
    label: "Control centre engineering workstation",
    roles: ["engineering"],
    tags: ["remote-enabled"],
    hardeningPermille: 300,
  },
  {
    id: "historian",
    kind: "historian",
    zone: "z-ctrl",
    label: "Operations historian",
    roles: ["historian"],
    tags: [],
    hardeningPermille: 350,
  },
  {
    id: "fep",
    kind: "front-end-processor",
    zone: "z-ctrl",
    label: "Front-end processor",
    roles: ["field-gateway"],
    tags: ["has-cmd-channel"],
    hardeningPermille: 400,
  },
  interlockingNode("il-tav", "z-il-tav", "Tavershall", "IL-TAV"),
  interlockingNode("il-vel", "z-il-vel", "Velmoor Junction", "IL-VEL"),
  interlockingNode("il-cre", "z-il-cre", "Crenmoor", "IL-CRE"),
  maintenanceNode("mws-tav", "z-il-tav", "Tavershall"),
  maintenanceNode("mws-vel", "z-il-vel", "Velmoor Junction"),
  maintenanceNode("mws-cre", "z-il-cre", "Crenmoor"),
  objectControllerNode("oc-tav", "Tavershall", "IL-TAV"),
  objectControllerNode("oc-vel", "Velmoor Junction", "IL-VEL"),
  objectControllerNode("oc-cre", "Crenmoor", "IL-CRE"),
];

const link = (
  id: string,
  a: string,
  b: string,
  protocols: string[],
  latencyTicks: number,
  conduit?: string,
): LinkDef =>
  conduit === undefined
    ? { id, a, b, protocols, latencyTicks }
    : { id, a, b, protocols, latencyTicks, conduit };

export const links: LinkDef[] = [
  // Corporate IT
  link("l-mail-dispatch", "corp-mail", "corp-ws-dispatch", ["smtp", "imap"], 3),
  link("l-mail-office", "corp-mail", "corp-ws-office", ["smtp", "imap"], 3),
  link("l-mail-dc", "corp-mail", "corp-dc", ["directory"], 2),
  link("l-dc-dispatch", "corp-dc", "corp-ws-dispatch", ["directory"], 2),
  link("l-dc-office", "corp-dc", "corp-ws-office", ["directory"], 2),
  // Vendor access
  {
    ...link("l-vpn-jump", "vpn-gw", "vendor-jump", ["remote-services"], 2),
    visibilityPermille: 250,
  },
  // Control centre. The consoles are thin clients that open a remote display
  // session on the traffic management server, hence remote-services next to
  // the supervisory protocol.
  link("l-tms-hmi1", "tms-server", "dispatch-hmi-1", ["scada-proto", "remote-services"], 2),
  link("l-tms-hmi2", "tms-server", "dispatch-hmi-2", ["scada-proto", "remote-services"], 2),
  link("l-tms-hist", "tms-server", "historian", ["historian-feed"], 2),
  link("l-tms-fep", "tms-server", "fep", ["scada-proto"], 2),
  link("l-tms-eng", "tms-server", "ctrl-eng-ws", ["remote-services"], 2),
  // Inside each interlocking zone
  link("l-mws-tav", "mws-tav", "il-tav", ["maintenance"], 2),
  link("l-mws-vel", "mws-vel", "il-vel", ["maintenance"], 2),
  link("l-mws-cre", "mws-cre", "il-cre", ["maintenance"], 2),
  // Across zones
  link("l-net-mail", "internet", "corp-mail", ["smtp"], 5, "c-net-corp"),
  // The vendor tunnel is encrypted: a sensor on it reads little of what crosses.
  {
    ...link("l-net-vpn", "internet", "vpn-gw", ["vpn"], 5, "c-net-vendor"),
    visibilityPermille: 250,
  },
  link("l-dispatch-dmz", "corp-ws-dispatch", "dmz-relay", ["remote-services"], 4, "c-corp-dmz"),
  link("l-dc-dmz", "corp-dc", "dmz-relay", ["patch"], 4, "c-corp-dmz"),
  link("l-dmz-hmi1", "dmz-relay", "dispatch-hmi-1", ["remote-services"], 3, "c-dmz-ctrl"),
  link("l-dmz-hist", "dmz-relay", "historian", ["historian-mirror"], 3, "c-dmz-ctrl"),
  link("l-jump-eng", "vendor-jump", "ctrl-eng-ws", ["remote-services"], 4, "c-vendor-ctrl"),
  link("l-fep-tav", "fep", "il-tav", ["scada-proto"], 3, "c-ctrl-tav"),
  link("l-fep-vel", "fep", "il-vel", ["scada-proto"], 3, "c-ctrl-vel"),
  link("l-fep-cre", "fep", "il-cre", ["scada-proto"], 3, "c-ctrl-cre"),
  link("l-eng-tav", "ctrl-eng-ws", "il-tav", ["maintenance"], 3, "c-ctrl-tav"),
  link("l-eng-vel", "ctrl-eng-ws", "il-vel", ["maintenance"], 3, "c-ctrl-vel"),
  link("l-eng-cre", "ctrl-eng-ws", "il-cre", ["maintenance"], 3, "c-ctrl-cre"),
  link("l-il-oc-tav", "il-tav", "oc-tav", ["safety-comms"], 2, "c-tav-way"),
  link("l-il-oc-vel", "il-vel", "oc-vel", ["safety-comms"], 2, "c-vel-way"),
  link("l-il-oc-cre", "il-cre", "oc-cre", ["safety-comms"], 2, "c-cre-way"),
];

export const conduits: ConduitDef[] = [
  { id: "c-net-corp", zoneA: "z-internet", zoneB: "z-corp", name: "Internet to corporate IT" },
  { id: "c-net-vendor", zoneA: "z-internet", zoneB: "z-vendor", name: "Internet to vendor access" },
  { id: "c-corp-dmz", zoneA: "z-corp", zoneB: "z-dmz", name: "Corporate IT to DMZ" },
  { id: "c-dmz-ctrl", zoneA: "z-dmz", zoneB: "z-ctrl", name: "DMZ to control centre" },
  {
    id: "c-vendor-ctrl",
    zoneA: "z-vendor",
    zoneB: "z-ctrl",
    name: "Vendor access to control centre",
  },
  {
    id: "c-ctrl-tav",
    zoneA: "z-ctrl",
    zoneB: "z-il-tav",
    name: "Control centre to Tavershall interlocking",
  },
  {
    id: "c-ctrl-vel",
    zoneA: "z-ctrl",
    zoneB: "z-il-vel",
    name: "Control centre to Velmoor Junction interlocking",
  },
  {
    id: "c-ctrl-cre",
    zoneA: "z-ctrl",
    zoneB: "z-il-cre",
    name: "Control centre to Crenmoor interlocking",
  },
  {
    id: "c-tav-way",
    zoneA: "z-il-tav",
    zoneB: "z-way",
    name: "Tavershall interlocking to trackside",
  },
  {
    id: "c-vel-way",
    zoneA: "z-il-vel",
    zoneB: "z-way",
    name: "Velmoor Junction interlocking to trackside",
  },
  {
    id: "c-cre-way",
    zoneA: "z-il-cre",
    zoneB: "z-way",
    name: "Crenmoor interlocking to trackside",
  },
];

export const interlockings: Content["interlockings"] = [
  { id: "IL-TAV", label: "Tavershall interlocking" },
  { id: "IL-VEL", label: "Velmoor Junction interlocking" },
  { id: "IL-CRE", label: "Crenmoor interlocking" },
];
