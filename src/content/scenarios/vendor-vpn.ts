import { playbook, type Scenario, stepAt } from "./types";

/**
 * Vendor VPN: the intruder signs in through the remote access service the vendor is meant
 * to use, looks around from the gateway, and follows the vendor path (vendor jump host,
 * then the control centre engineering workstation) straight into the control centre,
 * bypassing the DMZ that the office path has to cross. From the engineering workstation a
 * maintenance session reaches the Tavershall interlocking and takes its safety function
 * out. A fail-safe interlocking can only answer one way: its signals go dark and trains
 * stand at red. The tunnel is encrypted, so there is little for a sensor to read; the
 * dwell before anyone notices is the point of the story.
 *
 * The chain is one playbook, so every step starts two ticks after the one before it has
 * ended, however long each took. The seed is chosen so every roll goes the attacker's
 * way, and the start tick so a train is on the approach when the interlocking drops:
 * the chain lands about 23 seconds after the first packet and that train stands within a
 * second of it. A test pins both.
 */
export const vendorVpn: Scenario = {
  id: "vendor-vpn",
  title: "Vendor VPN",
  summary:
    "The intruder arrives over the vendor's remote access and walks the vendor path into the control centre, past the DMZ.",
  seed: 0,
  startTick: 30300,
  durationTicks: 31600,
  initialFootholds: [],
  actions: [
    playbook(30310, [
      stepAt("T0822", "vpn-gw"),
      stepAt("T0840", "vpn-gw"),
      stepAt("T0886", "vendor-jump"),
      stepAt("T0886", "ctrl-eng-ws"),
      stepAt("T0880", "il-tav"),
    ]),
  ],
};
