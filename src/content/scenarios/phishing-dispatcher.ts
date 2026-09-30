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
 * whole chain takes 18 seconds at normal speed. When the chain lands the
 * interlockings put every route that is set but not yet entered to stop, so
 * signals drop at that moment. It starts at tick 30631 because that is the
 * start in the timetable where, with nothing already held and no train
 * overrunning, the first train the lost command channel stops comes soonest:
 * about 32 seconds after the first packet. Service braking is 1 m/s^2, so a
 * train at line speed needs about half a minute to stand, and that is the
 * floor. A test pins it.
 */
export const phishingDispatcher: Scenario = {
  id: "phishing-dispatcher",
  title: "Phishing to the dispatcher",
  seed: 6,
  startTick: 30631,
  durationTicks: 31900,
  actions: [
    launch(30641, "T0865", "corp-ws-dispatch"),
    launch(30681, "T0840", "corp-ws-dispatch"),
    launch(30707, "T0886", "dmz-relay"),
    launch(30747, "T0886", "dispatch-hmi-1"),
    launch(30783, "T0886", "tms-server"),
  ],
};
