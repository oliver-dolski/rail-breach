import type { TechniqueDef } from "../../core/attack/types";

/**
 * The techniques of the first phishing chain, named and numbered as in
 * ATT&CK for ICS v19.2 (checked 2026-09-30). Everything stays at the level of
 * the technique name: no product, no vulnerability identifier, no command and
 * no payload appears anywhere, and the only physical consequence is a
 * railway that stops (see core/attack/effects).
 *
 * The full catalogue is generated from the pinned ATT&CK bundle in a later
 * phase; these three are written by hand to drive the vertical slice.
 */

export const spearphishingAttachment: TechniqueDef = {
  id: "T0865",
  name: "Spearphishing Attachment",
  tactic: "initial-access",
  protocol: "smtp",
  targets: { kinds: ["corp-workstation"] },
  pre: [{ k: "reach", from: "external", protocol: "smtp" }],
  durationTicks: [30, 50],
  successPermille: 950,
  resistance: "host-and-user",
  effects: [{ k: "foothold", priv: 1 }],
  explain:
    "A crafted message reaches a corporate user and one opened attachment gives the intruder a first foothold.",
};

export const networkConnectionEnumeration: TechniqueDef = {
  id: "T0840",
  name: "Network Connection Enumeration",
  tactic: "discovery",
  protocol: null,
  targets: {},
  pre: [{ k: "targetFoothold", min: 1 }],
  durationTicks: [20, 30],
  successPermille: 1000,
  resistance: "none",
  effects: [{ k: "discover", hops: 3 }],
  explain:
    "From the foothold the intruder lists which systems talk to which, learning where the next hops lead.",
};

export const remoteServices: TechniqueDef = {
  id: "T0886",
  name: "Remote Services",
  tactic: "lateral-movement",
  protocol: "remote-services",
  targets: {},
  pre: [{ k: "reach", from: "foothold", protocol: "remote-services" }, { k: "targetDiscovered" }],
  durationTicks: [30, 50],
  successPermille: 950,
  resistance: "host",
  effects: [
    { k: "foothold", priv: 1 },
    { k: "blockCommands", onTag: "has-cmd-channel" },
    { k: "denyControl", onTag: "has-cmd-channel" },
  ],
  explain:
    "A remote session over a permitted service moves the intruder on; on a system that owns a command channel the intruder holds the session and the operators lose that channel.",
};

export const techniques: TechniqueDef[] = [
  spearphishingAttachment,
  networkConnectionEnumeration,
  remoteServices,
];
