/**
 * Where everything sits on the schematic map. Presentation only: the core never
 * imports this file, and nothing here is meant to be to scale. Coordinates are
 * map units on a 1600 x 900 sheet; the renderer fits the sheet into the canvas.
 *
 * Top half: the cyber side, zones as boxes, nodes as glyphs, links as lines.
 * Bottom half: the railway, west to east, with the down line (towards Dunmarrow)
 * below the up line and the single-track branch to Pellthorne underneath.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface ZoneBox {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodePlacement extends Pt {
  /** Short on-map caption. */
  label: string;
}

export interface StationPlacement extends Pt {
  name: string;
}

export interface Layout {
  width: number;
  height: number;
  zones: ZoneBox[];
  nodes: Record<string, NodePlacement>;
  /** One polyline per block, in the direction of travel. */
  blocks: Record<string, Pt[]>;
  /** Extra track drawn between blocks that the block polylines do not cover. */
  connectors: Pt[][];
  stations: StationPlacement[];
  /** Short on-map caption of each conduit. */
  conduits: Record<string, string>;
  /**
   * Where each conduit's caption sits: on one of the conduit's own links, at this fraction of
   * its length from end a. A conduit without an entry gets the middle of its first link.
   * The spots are chosen so no caption touches another label or a zone border (a test checks).
   */
  conduitSpots: Record<string, { link: string; at: number }>;
}

const pts = (...xy: number[]): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < xy.length; i += 2) out.push({ x: xy[i] ?? 0, y: xy[i + 1] ?? 0 });
  return out;
};

const reversed = (line: Pt[]): Pt[] => [...line].reverse();

const UP_Y = 650;
const DN_Y = 710;
const BR_Y = 830;

const X = { HAR: 110, TAV: 455, VEL: 795, CRE: 1135, DUN: 1490 } as const;
const HALF = 50;
/** Half the width of an interlocking zone: wide enough for its own caption at the smallest map scale. */
const IL_HALF = 85;

const dn = (x0: number, x1: number): Pt[] => pts(x0, DN_Y, x1, DN_Y);
const up = (x0: number, x1: number): Pt[] => pts(x0, UP_Y, x1, UP_Y);

const brDn = pts(X.VEL + HALF, DN_Y, X.VEL + 95, 775, X.VEL + 145, BR_Y, 1260, BR_Y);
const brUp = [...reversed(brDn), ...pts(X.VEL + HALF, UP_Y)];

export const layout: Layout = {
  width: 1600,
  height: 900,
  zones: [
    { id: "z-internet", label: "INTERNET", x: 20, y: 40, w: 130, h: 180 },
    { id: "z-corp", label: "CORPORATE IT", x: 260, y: 40, w: 290, h: 250 },
    { id: "z-vendor", label: "VENDOR ACCESS", x: 20, y: 330, w: 330, h: 150 },
    { id: "z-dmz", label: "DMZ", x: 660, y: 90, w: 130, h: 180 },
    { id: "z-ctrl", label: "CONTROL CENTRE", x: 900, y: 40, w: 360, h: 282 },
    { id: "z-il-tav", label: "IL TAVERSHALL", x: X.TAV - IL_HALF, y: 380, w: 2 * IL_HALF, h: 130 },
    { id: "z-il-vel", label: "IL VELMOOR JN", x: X.VEL - IL_HALF, y: 380, w: 2 * IL_HALF, h: 130 },
    { id: "z-il-cre", label: "IL CRENMOOR", x: X.CRE - IL_HALF, y: 380, w: 2 * IL_HALF, h: 130 },
    { id: "z-way", label: "TRACKSIDE", x: 20, y: 525, w: 1560, h: 360 },
  ],
  nodes: {
    internet: { x: 85, y: 130, label: "Internet" },
    "corp-mail": { x: 330, y: 105, label: "Mail gateway" },
    "corp-ws-dispatch": { x: 470, y: 105, label: "Dispatcher WS" },
    "corp-dc": { x: 330, y: 225, label: "Directory" },
    "corp-ws-office": { x: 470, y: 225, label: "Office WS" },
    "vpn-gw": { x: 80, y: 405, label: "Vendor VPN" },
    "vendor-jump": { x: 270, y: 405, label: "Jump host" },
    "dmz-relay": { x: 725, y: 180, label: "DMZ relay" },
    "dispatch-hmi-1": { x: 980, y: 95, label: "Console 1" },
    "dispatch-hmi-2": { x: 1190, y: 95, label: "Console 2" },
    "tms-server": { x: 1130, y: 185, label: "Traffic mgmt" },
    "ctrl-eng-ws": { x: 990, y: 185, label: "Engineering WS" },
    historian: { x: 970, y: 270, label: "Historian" },
    fep: { x: 1130, y: 270, label: "Front-end proc." },
    "il-tav": { x: X.TAV - 30, y: 430, label: "IL-TAV" },
    "mws-tav": { x: X.TAV + 25, y: 472, label: "Maint. WS" },
    "il-vel": { x: X.VEL - 30, y: 430, label: "IL-VEL" },
    "mws-vel": { x: X.VEL + 25, y: 472, label: "Maint. WS" },
    "il-cre": { x: X.CRE - 30, y: 430, label: "IL-CRE" },
    "mws-cre": { x: X.CRE + 25, y: 472, label: "Maint. WS" },
    "oc-tav": { x: X.TAV, y: 570, label: "OC-TAV" },
    "oc-vel": { x: X.VEL, y: 570, label: "OC-VEL" },
    "oc-cre": { x: X.CRE, y: 570, label: "OC-CRE" },
  },
  blocks: {
    HAR_dn: dn(60, X.HAR + HALF),
    L1_dn: dn(X.HAR + HALF, X.TAV - HALF),
    TAV_dn: dn(X.TAV - HALF, X.TAV + HALF),
    L2_dn: dn(X.TAV + HALF, X.VEL - HALF),
    VEL_dn: dn(X.VEL - HALF, X.VEL + HALF),
    L3_dn: dn(X.VEL + HALF, X.CRE - HALF),
    CRE_dn: dn(X.CRE - HALF, X.CRE + HALF),
    L4_dn: dn(X.CRE + HALF, X.DUN - HALF),
    DUN_dn: dn(X.DUN - HALF, X.DUN + 50),
    DUN_up: up(X.DUN + 50, X.DUN - HALF),
    L4_up: up(X.DUN - HALF, X.CRE + HALF),
    CRE_up: up(X.CRE + HALF, X.CRE - HALF),
    L3_up: up(X.CRE - HALF, X.VEL + HALF),
    VEL_up: up(X.VEL + HALF, X.VEL - HALF),
    L2_up: up(X.VEL - HALF, X.TAV + HALF),
    TAV_up: up(X.TAV + HALF, X.TAV - HALF),
    L1_up: up(X.TAV - HALF, X.HAR + HALF),
    HAR_up: up(X.HAR + HALF, 60),
    BR_dn: brDn,
    PEL_dn: pts(1260, BR_Y, 1360, BR_Y),
    PEL_up: pts(1360, BR_Y, 1260, BR_Y),
    BR_up: brUp,
  },
  connectors: [pts(X.VEL + HALF, DN_Y, X.VEL + HALF, UP_Y)],
  stations: [
    { name: "Harkwell", x: X.HAR, y: DN_Y + 34 },
    { name: "Tavershall", x: X.TAV, y: DN_Y + 34 },
    // Left of the station: centred on it, the name would touch the branch line that leaves to the right.
    { name: "Velmoor Junction", x: X.VEL - 45, y: DN_Y + 34 },
    { name: "Crenmoor", x: X.CRE, y: DN_Y + 34 },
    { name: "Dunmarrow", x: X.DUN, y: DN_Y + 34 },
    { name: "Pellthorne", x: 1310, y: BR_Y + 26 },
  ],
  conduits: {
    "c-net-corp": "Net-Corp",
    "c-net-vendor": "Net-Vendor",
    "c-corp-dmz": "Corp-DMZ",
    "c-dmz-ctrl": "DMZ-Ctrl",
    "c-vendor-ctrl": "Vendor-Ctrl",
    "c-ctrl-tav": "Ctrl-TAV",
    "c-ctrl-vel": "Ctrl-VEL",
    "c-ctrl-cre": "Ctrl-CRE",
    "c-tav-way": "TAV-Way",
    "c-vel-way": "VEL-Way",
    "c-cre-way": "CRE-Way",
  },
  conduitSpots: {
    // Between the trackside border and the object controller, clear of the interlocking zone above.
    "c-tav-way": { link: "l-il-oc-tav", at: 0.8 },
    "c-vel-way": { link: "l-il-oc-vel", at: 0.8 },
    "c-cre-way": { link: "l-il-oc-cre", at: 0.8 },
  },
};
