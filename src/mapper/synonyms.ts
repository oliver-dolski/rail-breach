/**
 * The words a viewer might use for each technique, by current ID. One table feeds the
 * offline matcher and the picker's search, so the two never disagree about what "spoof"
 * means. A longer single word matches the start of a word ("phish" takes "phishing"); a
 * short one (four letters or fewer) only the word and its plain endings; several words match
 * as a phrase. The text is lower-cased and stripped of filler words first, so "spoof the
 * reports" is looked for as "spoof reports", except for a phrase that filler would reduce to
 * one word ("log in"), which must appear as typed.
 */
export const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  T0865: ["phish", "spearphish", "attachment", "lure", "email", "e-mail", "malicious mail"],
  T0822: [
    "vpn",
    "vendor",
    "supplier",
    "contractor",
    "third party",
    "third-party",
    "remote access",
    "remote support",
    "external remote",
  ],
  T0859: [
    "insider",
    "valid account",
    "stolen account",
    "credential",
    "password",
    "login",
    "log in",
    "log into",
    "account",
  ],
  T0886: [
    "remote service",
    "remote session",
    "remote desktop",
    "rdp",
    "ssh",
    "lateral",
    "pivot",
    "jump",
  ],
  T0866: ["exploit", "vulnerab", "unpatched", "zero day", "zero-day"],
  T0840: ["scan", "enumerat", "recon", "discover", "probe", "sniff", "map network"],
  "T1692.001": [
    "unauthorized command",
    "unauthorised command",
    "command message",
    "spoof command",
    "forge command",
    "false command",
    "inject command",
    "send command",
  ],
  T0836: ["modify parameter", "parameter", "setpoint", "tamper", "speed limit", "reconfigure"],
  "T1691.001": [
    "block command",
    "block message",
    "command channel",
    "cut off",
    "jam",
    "drop command",
  ],
  T0813: ["denial of control", "deny control", "lock out", "lockout", "take control"],
  T0829: ["loss of view", "lose view", "blind", "blackout", "black out", "go dark", "hide"],
  T0880: [
    "loss of safety",
    "disable safety",
    "safety system",
    "bypass interlocking",
    "disable interlocking",
    "turn off safety",
  ],
  "T1692.002": [
    "spoof report",
    "spoofed report",
    "fake report",
    "false report",
    "falsif",
    "reporting message",
    "fake status",
    "spoof status",
  ],
};

/** Words that say where to aim, each naming roles in order of preference. */
export const TARGET_HINTS: Readonly<Record<string, readonly string[]>> = {
  dispatcher: ["dispatcher-ws", "dispatcher-hmi"],
  dispatch: ["dispatcher-ws", "dispatcher-hmi"],
  console: ["dispatcher-hmi"],
  "signal box": ["signal-box-ws"],
  signalbox: ["signal-box-ws"],
  vendor: ["vendor-access"],
  vpn: ["vendor-access"],
  "mail gateway": ["mail"],
  "mail server": ["mail"],
  historian: ["historian"],
  directory: ["directory"],
  "domain controller": ["directory"],
  tms: ["traffic-management"],
  "traffic management": ["traffic-management"],
  engineering: ["engineering"],
  relay: ["relay"],
  dmz: ["relay"],
  "front end": ["field-gateway"],
  gateway: ["field-gateway"],
  office: ["office-ws"],
};
