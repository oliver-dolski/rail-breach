/**
 * Data-only content shapes. Content is injected into the core through
 * createWorld(content, seed); the core never imports concrete content.
 */

export type ZoneId = string;
export type NodeId = string;
export type LinkId = string;
export type ConduitId = string;
export type InterlockingId = string;
export type TrainId = string;
export type Protocol = string;
export type Role = string;
export type Tag = string;

export interface Zone {
  id: ZoneId;
  name: string;
  /** Purdue level, display and sensible defaults only. */
  purdue: 0 | 1 | 2 | 3 | 3.5 | 4 | 5 | "ext";
  /** IEC 62443 target security level, informational. */
  slTarget: 1 | 2 | 3 | 4;
}

export type NodeKind =
  | "external"
  | "corp-workstation"
  | "mail-server"
  | "domain-controller"
  | "vpn-gateway"
  | "vendor-jump-host"
  | "dmz-relay"
  | "scada-server"
  | "hmi"
  | "engineering-ws"
  | "historian"
  | "front-end-processor"
  | "interlocking"
  | "object-controller";

export interface NodeDef {
  id: NodeId;
  kind: NodeKind;
  zone: ZoneId;
  label: string;
  roles: Role[];
  tags: Tag[];
  /** Shifts technique success down. Permille. */
  hardeningPermille: number;
  /** User-facing nodes only. Permille. */
  awarenessPermille?: number;
  /** Ties an interlocking or object controller to the track side. */
  controls?: InterlockingId;
}

export interface LinkDef {
  id: LinkId;
  a: NodeId;
  b: NodeId;
  protocols: Protocol[];
  /** Hop time in ticks. Drives particle travel and attack pacing. */
  latencyTicks: number;
  /** Set on links that cross zones. */
  conduit?: ConduitId;
}

/** IEC 62443 conduit: the group of channels between two zones. */
export interface ConduitDef {
  id: ConduitId;
  zoneA: ZoneId;
  zoneB: ZoneId;
  name: string;
}

export interface InterlockingDef {
  id: InterlockingId;
  label: string;
}

export interface TrainDef {
  id: TrainId;
  /** Starting position along the line, in decimetres. */
  startPosDm: number;
}

export interface Content {
  zones: Zone[];
  nodes: NodeDef[];
  links: LinkDef[];
  conduits: ConduitDef[];
  interlockings: InterlockingDef[];
  trains: TrainDef[];
}
