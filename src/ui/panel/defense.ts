import type { Content, Zone } from "../../content/types";
import type { DefenseKind } from "../../core/net/defenses";
import type { Action } from "../../core/sim/actions";
import { DEFENSE_PLACEMENT_LATENCY_TICKS, TICKS_PER_SECOND } from "../../core/sim/constants";
import type { World } from "../../core/sim/world";
import { h, setText } from "../dom";

/**
 * The defense palette: pick what to place, then click a conduit on the map or its
 * button in the list, and take a placed defense away again. It builds actions and
 * hands them on; it never touches the world. All text goes in as text.
 */

export type PlaceAction = Extract<Action, { type: "defense.place" }>;

/** Which way a diode lets data pass: towards the corporate side or towards the trackside. */
export type Flow = "office" | "tracks";

export interface DefenseChoice {
  kind: DefenseKind;
  flow: Flow;
}

export const KIND_LABEL: Record<DefenseKind, string> = {
  firewall: "Firewall",
  diode: "Data diode",
  ids: "IDS sensor",
};

/** Purdue level as a number, the Internet above everything. Higher is nearer the office. */
const purdueRank = (zone: Zone | undefined): number =>
  zone === undefined ? 0 : zone.purdue === "ext" ? 6 : zone.purdue;

/**
 * The action that places `choice` on a conduit, or undefined for a conduit the content
 * does not have. A diode's direction is the conduit's own (zone A to zone B), worked out
 * from the two zones' Purdue levels so the choice reads as office or tracks.
 */
export function placementFor(
  choice: DefenseChoice,
  conduitId: string,
  content: Content,
): PlaceAction | undefined {
  const conduit = content.conduits.find((c) => c.id === conduitId);
  if (conduit === undefined) return undefined;
  const on = { conduit: conduitId };
  if (choice.kind !== "diode") return { type: "defense.place", kind: choice.kind, on };
  const zoneA = content.zones.find((z) => z.id === conduit.zoneA);
  const zoneB = content.zones.find((z) => z.id === conduit.zoneB);
  const aIsNearerTracks = purdueRank(zoneA) < purdueRank(zoneB);
  const towardsOffice = aIsNearerTracks ? "a-to-b" : "b-to-a";
  const towardsTracks = aIsNearerTracks ? "b-to-a" : "a-to-b";
  return {
    type: "defense.place",
    kind: "diode",
    on,
    config: { direction: choice.flow === "office" ? towardsOffice : towardsTracks },
  };
}

/** One placement as the list shows it: all the links it made count as one. */
export interface PlacedRow {
  id: string;
  text: string;
}

/** The placements in the world, in the order they were made, worded for the panel. */
export function placedRows(world: World, content: Content): PlacedRow[] {
  const zoneName = (nodeId: string): string => {
    const zone = content.nodes.find((n) => n.id === nodeId)?.zone;
    return content.zones.find((z) => z.id === zone)?.name ?? nodeId;
  };
  const rows: PlacedRow[] = [];
  const seen = new Set<string>();
  for (const first of world.defenses) {
    if (seen.has(first.id)) continue;
    seen.add(first.id);
    const members = world.defenses.filter((d) => d.id === first.id);
    const conduit = content.conduits.find((c) => c.id === first.conduit);
    const link = content.links.find((l) => l.id === first.link);
    const where = conduit?.name ?? link?.id ?? first.link;
    let detail = "";
    if (first.kind === "diode" && link !== undefined) {
      const [from, to] = first.direction === "a-to-b" ? [link.a, link.b] : [link.b, link.a];
      detail = ` (data ${zoneName(from)} to ${zoneName(to)})`;
    } else if (first.kind === "firewall") {
      detail =
        first.allow.length === 0 ? " (blocks everything)" : ` (allows ${first.allow.join(", ")})`;
    }
    const activeFrom = Math.max(...members.map((d) => d.activeFrom));
    const left = Math.max(0, Math.ceil((activeFrom - world.tick) / TICKS_PER_SECOND));
    const state = world.tick >= activeFrom ? "in force" : `in force in ${left} s`;
    rows.push({ id: first.id, text: `${KIND_LABEL[first.kind]} on ${where}${detail}, ${state}` });
  }
  return rows;
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export interface DefensePalette {
  /** Places the armed defense on a conduit, as a click on the map does. */
  place(conduitId: string): void;
  update(world: World, live: boolean): void;
}

export interface DefenseDeps {
  content: Content;
  onAction(action: Action): void;
  onReset(): void;
}

export function createDefensePalette(doc: Document, deps: DefenseDeps): DefensePalette {
  const kindGroup = need(doc, "defense-kind");
  const flowGroup = need(doc, "defense-flow");
  const conduitList = need(doc, "defense-conduits");
  const placedList = need(doc, "defense-placed");
  const note = need(doc, "defense-note");
  const choice: DefenseChoice = { kind: "firewall", flow: "office" };

  const pressed = (group: HTMLElement, attr: string, value: string): void => {
    for (const button of Array.from(group.querySelectorAll("button"))) {
      button.setAttribute("aria-pressed", button.getAttribute(attr) === value ? "true" : "false");
    }
  };

  kindGroup.addEventListener("click", (event) => {
    const kind = (event.target as HTMLElement).getAttribute("data-kind");
    if (kind !== "firewall" && kind !== "diode" && kind !== "ids") return;
    choice.kind = kind;
    pressed(kindGroup, "data-kind", kind);
    flowGroup.hidden = kind !== "diode";
  });
  flowGroup.addEventListener("click", (event) => {
    const flow = (event.target as HTMLElement).getAttribute("data-flow");
    if (flow !== "office" && flow !== "tracks") return;
    choice.flow = flow;
    pressed(flowGroup, "data-flow", flow);
  });

  const place = (conduitId: string): void => {
    const action = placementFor(choice, conduitId, deps.content);
    if (action !== undefined) deps.onAction(action);
  };

  for (const conduit of deps.content.conduits) {
    const button = h(doc, "button", { type: "button", "data-conduit": conduit.id }, conduit.name);
    button.addEventListener("click", () => place(conduit.id));
    conduitList.append(button);
  }
  need(doc, "defense-reset").addEventListener("click", () => deps.onReset());

  const rows = new Map<string, { li: HTMLElement; label: HTMLElement }>();
  return {
    place,
    update(world, live) {
      const wanted = placedRows(world, deps.content);
      const ids = new Set(wanted.map((r) => r.id));
      for (const [id, row] of rows) {
        if (ids.has(id)) continue;
        row.li.remove();
        rows.delete(id);
      }
      for (const row of wanted) {
        let entry = rows.get(row.id);
        if (entry === undefined) {
          const label = h(doc, "span", { class: "placed-label" });
          const remove = h(
            doc,
            "button",
            { type: "button", "aria-label": `Remove ${row.id}` },
            "Remove",
          );
          remove.addEventListener("click", () =>
            deps.onAction({ type: "defense.remove", id: row.id }),
          );
          const li = h(doc, "li", { "data-key": row.id }, label, remove);
          placedList.append(li);
          entry = { li, label };
          rows.set(row.id, entry);
        }
        setText(entry.label, row.text);
      }
      setText(
        note,
        live
          ? `Live run: your defenses are in play, so this is no longer the recorded session. A defense takes ${DEFENSE_PLACEMENT_LATENCY_TICKS / TICKS_PER_SECOND} s to come into force.`
          : "Replaying the recorded session. Place a defense to branch from this moment.",
      );
    },
  };
}
