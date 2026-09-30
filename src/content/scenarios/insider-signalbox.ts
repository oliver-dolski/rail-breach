import { footholdActions, playbook, type Scenario, stepAt } from "./types";

/**
 * Insider in the interlocking: the scenario starts from an assumed breach. Someone with a
 * genuine maintenance account at the Velmoor Junction signal box workstation already holds
 * that machine, so there is no way in to show, only what they do with it. They list what
 * the workstation talks to, open a session on the interlocking with the account, lower
 * the speed its sections allow and then take its safety function out. The interlocking
 * answers restrictively at every step: trains crawl, then signals go dark and trains stand.
 * Nothing here is broken until the last step, so nothing looks broken until then.
 *
 * The chain is one playbook, so every step starts two ticks after the one before it has
 * ended. The seed is chosen so every roll goes the attacker's way, and the start tick so a
 * train is on the approach when the interlocking drops: the chain lands about 21 seconds
 * after the first action and that train stands within a second of it. A test pins both.
 */
const FOOTHOLDS = ["mws-vel"];

export const insiderSignalbox: Scenario = {
  id: "insider-signalbox",
  title: "Insider in the signal box",
  summary:
    "An insider with a genuine maintenance account starts inside the Velmoor Junction signal box and works on the interlocking.",
  seed: 38,
  startTick: 31740,
  durationTicks: 33100,
  initialFootholds: FOOTHOLDS,
  actions: [
    ...footholdActions(FOOTHOLDS),
    playbook(31750, [
      stepAt("T0840", "mws-vel"),
      stepAt("T0859", "il-vel"),
      stepAt("T0836", "il-vel"),
      stepAt("T0880", "il-vel"),
    ]),
  ],
};
