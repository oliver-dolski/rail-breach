/**
 * Data-only content shapes. Content is injected into the core through
 * createWorld(content, seed); the core never imports concrete content.
 */

export type ZoneId = string;
export type NodeId = string;
export type LinkId = string;
export type ConduitId = string;
export type InterlockingId = string;
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
  /**
   * How much of the traffic a sensor on this link can read, in permille. Absent means all
   * of it; an encrypted tunnel shows far less. Shifts detection down, never up.
   */
  visibilityPermille?: number;
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

export type BlockId = string;
/** Axle-counter section: the unit of occupancy detection. Blocks may share one. */
export type SectionId = string;
export type SignalId = string;
export type PointId = string;
export type RouteId = string;
export type ServiceId = string;
export type PointPos = "normal" | "reverse";

/**
 * A directed stretch of track. Position is measured along the direction of
 * travel, so a signal at atDm === lengthDm stands at the far end of the block.
 * A single-track stretch used both ways is two blocks that share one section.
 */
export interface BlockDef {
  id: BlockId;
  section: SectionId;
  lengthDm: number;
  /** Blocks a train can enter from the far end of this one. */
  next: BlockId[];
  /** The object controller that evaluates this section's axle counters. */
  controller: NodeId;
}

export interface PointDef {
  id: PointId;
  interlocking: InterlockingId;
  controller: NodeId;
  /** Ticks the blades take to move; the point is only detected once they arrive. */
  movingTicks: number;
  toe: BlockId;
  normal: BlockId;
  reverse: BlockId;
  /** Sections that must be clear of trains before the blades may move. */
  zone: SectionId[];
}

export interface SignalDef {
  id: SignalId;
  block: BlockId;
  /** Offset from the start of the block. Signals stand at the far end of their block. */
  atDm: number;
  controller: NodeId;
  interlocking: InterlockingId;
  /** Safety distance past the signal. Must cover the emergency braking distance at vmax. */
  overlapDm: number;
}

export interface RoutePoint {
  point: PointId;
  pos: PointPos;
}

export interface RouteDef {
  id: RouteId;
  interlocking: InterlockingId;
  entrySignal: SignalId;
  /** Blocks the train runs over after the entry signal, in order. */
  blocks: BlockId[];
  points: RoutePoint[];
  /** Blocks beyond the route's end signal that must stay clear. */
  overlap: BlockId[];
}

export interface StopDef {
  /** The train halts at the far end of this block. */
  block: BlockId;
  dwellTicks: number;
}

/** A timetabled service: departures at firstTick + n * headwayTicks, n < count. */
export interface ServiceDef {
  id: ServiceId;
  path: BlockId[];
  stops: StopDef[];
  firstTick: number;
  headwayTicks: number;
  count: number;
}

export interface TrackContent {
  /** Line speed in decimetres per tick. */
  vmaxDmPerTick: number;
  blocks: BlockDef[];
  points: PointDef[];
  signals: SignalDef[];
  routes: RouteDef[];
  services: ServiceDef[];
}

export interface Content {
  zones: Zone[];
  nodes: NodeDef[];
  links: LinkDef[];
  conduits: ConduitDef[];
  interlockings: InterlockingDef[];
  tracks: TrackContent;
}
