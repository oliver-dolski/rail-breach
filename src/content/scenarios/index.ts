import { insiderSignalbox } from "./insider-signalbox";
import { phishingDispatcher } from "./phishing-dispatcher";
import type { Scenario } from "./types";
import { vendorVpn } from "./vendor-vpn";

export type { Scenario } from "./types";
export { insiderSignalbox, phishingDispatcher, vendorVpn };

/** Every scenario, in the order the selector lists them. The first is the one attract mode opens on. */
export const scenarios: readonly Scenario[] = [phishingDispatcher, vendorVpn, insiderSignalbox];
