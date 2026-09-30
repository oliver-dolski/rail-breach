import type { TechniqueDef } from "../../core/attack/types";
import { DENIAL_OF_CONTROL_RECOVER_TICKS } from "../../core/sim/constants";

/**
 * The technique rules, numbered as in ATT&CK for ICS v19.2 (checked 2026-09-30).
 * Everything stays at the level of the technique name: no product, no
 * vulnerability identifier, no command and no payload appears anywhere, and the
 * only physical consequence is a railway that stops (see core/attack/effects).
 *
 * The rules are written here; the names, tactics and legacy IDs they must agree
 * with are generated from the pinned ATT&CK bundle into attack-ics.json
 * (scripts/build-attack.mjs), and validateTechniques checks every definition
 * against that catalogue.
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
  signaturePermille: 250,
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
  signaturePermille: 0,
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
  signaturePermille: 200,
  effects: [
    { k: "foothold", priv: 1 },
    { k: "blockCommands", onTag: "has-cmd-channel" },
    { k: "denyControl", onTag: "has-cmd-channel" },
  ],
  explain:
    "A remote session over a permitted service moves the intruder on; on a system that owns a command channel the intruder holds the session and the operators lose that channel.",
};

export const externalRemoteServices: TechniqueDef = {
  id: "T0822",
  name: "External Remote Services",
  tactic: "initial-access",
  protocol: "vpn",
  targets: { kinds: ["vpn-gateway"] },
  pre: [{ k: "reach", from: "external", protocol: "vpn" }],
  durationTicks: [30, 50],
  successPermille: 850,
  resistance: "host",
  signaturePermille: 120,
  effects: [{ k: "foothold", priv: 1 }],
  explain:
    "The intruder signs in through the remote access service that the vendor is meant to use and arrives inside the network as a trusted party.",
};

export const validAccounts: TechniqueDef = {
  id: "T0859",
  name: "Valid Accounts",
  tactic: "lateral-movement",
  protocol: "maintenance",
  targets: { kinds: ["interlocking", "engineering-ws"] },
  pre: [{ k: "reach", from: "foothold", protocol: "maintenance" }, { k: "targetDiscovered" }],
  durationTicks: [20, 40],
  successPermille: 900,
  resistance: "none",
  signaturePermille: 100,
  effects: [{ k: "foothold", priv: 1 }],
  explain:
    "A genuine maintenance account opens a session on the engineering interface; nothing is broken, so nothing looks broken.",
};

export const exploitationOfRemoteServices: TechniqueDef = {
  id: "T0866",
  name: "Exploitation of Remote Services",
  tactic: "lateral-movement",
  protocol: "remote-services",
  targets: { tags: ["unpatched"] },
  pre: [{ k: "reach", from: "foothold", protocol: "remote-services" }, { k: "targetDiscovered" }],
  durationTicks: [40, 70],
  successPermille: 800,
  resistance: "host",
  signaturePermille: 600,
  effects: [{ k: "foothold", priv: 2 }],
  explain:
    "A weakness in a remote service that was never patched lets the intruder in without any credentials and with system-level reach.",
};

export const unauthorizedCommandMessage: TechniqueDef = {
  id: "T1692.001",
  legacyId: "T0855",
  name: "Unauthorized Message: Command Message",
  tactic: "impair-process-control",
  protocol: "scada-proto",
  targets: { kinds: ["interlocking"] },
  pre: [{ k: "reach", from: "foothold", protocol: "scada-proto" }, { k: "targetDiscovered" }],
  durationTicks: [30, 50],
  successPermille: 900,
  resistance: "none",
  signaturePermille: 550,
  effects: [{ k: "blockCommands" }],
  explain:
    "Commands that no dispatcher sent reach one interlocking; it can only answer them restrictively, so routes are refused and signals stay at danger.",
};

export const modifyParameter: TechniqueDef = {
  id: "T0836",
  name: "Modify Parameter",
  tactic: "impair-process-control",
  protocol: "maintenance",
  targets: { kinds: ["interlocking"] },
  pre: [{ k: "reach", from: "foothold", protocol: "maintenance" }, { k: "targetDiscovered" }],
  durationTicks: [30, 60],
  successPermille: 800,
  resistance: "none",
  signaturePermille: 350,
  effects: [{ k: "clampParam", param: "speed", permille: 250 }],
  explain:
    "An engineering parameter is changed so the sections of one interlocking carry a far lower speed limit; the vital layer only ever accepts a change that makes things safer, so trains crawl.",
};

export const blockCommandMessage: TechniqueDef = {
  id: "T1691.001",
  legacyId: "T0803",
  name: "Block Operational Technology Message: Command Message",
  tactic: "inhibit-response-function",
  protocol: "scada-proto",
  targets: { kinds: ["front-end-processor", "scada-server", "interlocking"] },
  pre: [{ k: "reach", from: "foothold", protocol: "scada-proto" }, { k: "targetDiscovered" }],
  durationTicks: [30, 50],
  successPermille: 900,
  resistance: "host",
  signaturePermille: 450,
  effects: [{ k: "blockCommands" }],
  explain:
    "Commands are accepted by the console and never arrive; dispatchers set routes and nothing happens, so trains queue at red signals.",
};

export const denialOfControl: TechniqueDef = {
  id: "T0813",
  name: "Denial of Control",
  tactic: "impact",
  protocol: "scada-proto",
  targets: { kinds: ["hmi", "scada-server"] },
  pre: [{ k: "reach", from: "foothold", protocol: "scada-proto" }],
  durationTicks: [20, 40],
  successPermille: 900,
  resistance: "host",
  signaturePermille: 500,
  effects: [
    {
      k: "denyControl",
      onTag: "has-cmd-channel",
      recoverTicks: DENIAL_OF_CONTROL_RECOVER_TICKS,
    },
  ],
  explain:
    "The operators' controls lock up for a while: they can watch the line but cannot steer it until the session recovers on its own.",
};

export const lossOfView: TechniqueDef = {
  id: "T0829",
  name: "Loss of View",
  tactic: "impact",
  protocol: "scada-proto",
  targets: { kinds: ["hmi", "scada-server"] },
  pre: [{ k: "reach", from: "foothold", protocol: "scada-proto" }],
  durationTicks: [30, 60],
  successPermille: 850,
  resistance: "host",
  signaturePermille: 400,
  effects: [{ k: "setView", state: "frozen" }],
  explain:
    "The track diagram freezes: the operators no longer see where trains are, and only a local restoration at the station brings the picture back.",
};

export const lossOfSafety: TechniqueDef = {
  id: "T0880",
  name: "Loss of Safety",
  tactic: "impact",
  protocol: "maintenance",
  targets: { kinds: ["interlocking"] },
  pre: [{ k: "reach", from: "foothold", protocol: "maintenance" }, { k: "targetDiscovered" }],
  durationTicks: [60, 100],
  successPermille: 850,
  resistance: "host",
  signaturePermille: 500,
  effects: [{ k: "degrade", state: "down" }],
  explain:
    "The safety function of one interlocking is taken out; a fail-safe system answers by going to its safe state, with signals at danger and trains held.",
};

export const unauthorizedReportingMessage: TechniqueDef = {
  id: "T1692.002",
  legacyId: "T0856",
  name: "Unauthorized Message: Reporting Message",
  tactic: "impair-process-control",
  protocol: "scada-proto",
  targets: { kinds: ["hmi", "scada-server"] },
  pre: [{ k: "reach", from: "foothold", protocol: "scada-proto" }],
  durationTicks: [25, 40],
  successPermille: 900,
  resistance: "host",
  signaturePermille: 400,
  effects: [{ k: "setView", state: "spoofed" }],
  explain:
    "From a foothold on the supervisory path the intruder feeds the operators reports that look right and are not; their picture of the line departs from the track while the interlocking keeps reading its own protected inputs.",
};

export const techniques: TechniqueDef[] = [
  spearphishingAttachment,
  externalRemoteServices,
  validAccounts,
  remoteServices,
  exploitationOfRemoteServices,
  networkConnectionEnumeration,
  unauthorizedCommandMessage,
  modifyParameter,
  blockCommandMessage,
  unauthorizedReportingMessage,
  denialOfControl,
  lossOfView,
  lossOfSafety,
];
