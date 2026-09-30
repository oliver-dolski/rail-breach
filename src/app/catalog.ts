import { type Scenario, scenarios } from "../content/scenarios";
import insiderRecording from "../recordings/insider-signalbox.json";
import phishingRecording from "../recordings/phishing-dispatcher.json";
import vendorRecording from "../recordings/vendor-vpn.json";

/**
 * Every scenario with its committed recording. Content holds the scenarios and knows
 * nothing of recordings; the pairing lives here, where the session is built. A recording
 * is data captured by the real engine (scripts/regen-recordings.mjs), so it is opaque
 * until assertRecording has looked at it.
 */
export interface CatalogEntry {
  scenario: Scenario;
  recording: unknown;
}

const recordings: Record<string, unknown> = {
  "phishing-dispatcher": phishingRecording,
  "vendor-vpn": vendorRecording,
  "insider-signalbox": insiderRecording,
};

export const catalog: readonly CatalogEntry[] = scenarios.map((scenario) => ({
  scenario,
  recording: recordings[scenario.id],
}));

/** The committed recording of a scenario, or undefined for one that has none. */
export function recordingFor(scenarioId: string): unknown {
  return recordings[scenarioId];
}

export function entryFor(scenarioId: string): CatalogEntry | undefined {
  return catalog.find((e) => e.scenario.id === scenarioId);
}
