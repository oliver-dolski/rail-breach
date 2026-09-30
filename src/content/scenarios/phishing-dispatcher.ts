import type { TimedAction } from "../../core/replay/recording";

/**
 * A scenario is an ordered list of already-resolved actions plus the seed that
 * decides every roll. Nothing else is stored: no free text, no key, no output
 * of any model. Replaying it never leaves the engine.
 */
export interface Scenario {
  id: string;
  title: string;
  seed: number;
  /** Length of the recorded session in ticks (10 ticks are one simulated second). */
  durationTicks: number;
  actions: TimedAction[];
}

const launch = (t: number, technique: string, target: string): TimedAction => ({
  t,
  a: { type: "technique.launch", technique, target },
});

/**
 * Phishing to the dispatcher: a message lands on the dispatcher's office
 * workstation, the intruder maps what it can talk to, then moves by remote
 * session through the DMZ relay and a dispatcher console to the traffic
 * management server, where the operators lose their command channel. The
 * railway answers the only way a fail-safe interlocking can: routes stop being
 * set and trains stand at red signals. Nothing gets a proceed it did not have.
 *
 * The seed is chosen so every roll in the chain goes the attacker's way; a
 * test pins that, so a change to the engine cannot silently break the story.
 * Actions are spaced so each operation has finished before the next launches.
 */
export const phishingDispatcher: Scenario = {
  id: "phishing-dispatcher",
  title: "Phishing to the dispatcher",
  seed: 6,
  durationTicks: 3000,
  actions: [
    launch(200, "T0865", "corp-ws-dispatch"),
    launch(300, "T0840", "corp-ws-dispatch"),
    launch(400, "T0886", "dmz-relay"),
    launch(500, "T0886", "dispatch-hmi-1"),
    launch(600, "T0886", "tms-server"),
  ],
};
