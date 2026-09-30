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
  /**
   * Tick at which attract mode starts showing the session. The engine runs the
   * quiet stretch before it in one go, so the viewer meets a railway that is
   * already busy and sees the first packet within a second, at normal speed.
   * A playback choice only: it is not part of the recording.
   */
  startTick: number;
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
 * Each action launches two ticks after the previous operation finished, so the
 * whole chain takes 19 seconds at normal speed. It starts at tick 7362 because
 * that is the start in the timetable where the first train held by the lost
 * command channel stops soonest: service braking is 1 m/s^2, so a train at line
 * speed needs about half a minute to stand, and no start gets a halt that the
 * attack caused sooner than 48 seconds after the first packet. A test pins it.
 */
export const phishingDispatcher: Scenario = {
  id: "phishing-dispatcher",
  title: "Phishing to the dispatcher",
  seed: 6,
  startTick: 7352,
  durationTicks: 8600,
  actions: [
    launch(7362, "T0865", "corp-ws-dispatch"),
    launch(7404, "T0840", "corp-ws-dispatch"),
    launch(7433, "T0886", "dmz-relay"),
    launch(7472, "T0886", "dispatch-hmi-1"),
    launch(7509, "T0886", "tms-server"),
  ],
};
