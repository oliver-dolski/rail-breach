import type { DiscInstance, LineInstance, PanelInstance, RenderView, ViewContext } from "../view";
import { type IntroLevel, TRACK_LEVEL } from "./levels";

/**
 * The board split into the intro's layers. Each layer is a RenderView holding only what hangs in
 * that level, built from the very instance objects of the full view (no colour is copied), so
 * drawing the five layers at the flat pose draws the board once. What crosses between zones, and
 * what the viewer has put on the line, goes to the bridges, which the intro draws separately.
 */
export interface PartitionedView {
  layers: RenderView[];
  bridges: RenderView;
}

/** The instance lists of one view while it is being filled. */
interface Lists {
  panels: PanelInstance[];
  links: LineInstance[];
  trail: LineInstance[];
  track: LineInstance[];
  routes: LineInstance[];
  trains: LineInstance[];
  signals: DiscInstance[];
  halos: DiscInstance[];
  nodes: DiscInstance[];
  defenses: DiscInstance[];
  defenseArrows: LineInstance[];
  alerts: LineInstance[];
}

const emptyLists = (): Lists => ({
  panels: [],
  links: [],
  trail: [],
  track: [],
  routes: [],
  trains: [],
  signals: [],
  halos: [],
  nodes: [],
  defenses: [],
  defenseArrows: [],
  alerts: [],
});

export function partitionView(
  view: RenderView,
  ctx: ViewContext,
  levels: readonly IntroLevel[],
): PartitionedView {
  const levelOfZone = new Map<string, number>();
  for (const level of levels) for (const id of level.zoneIds) levelOfZone.set(id, level.index);

  /** The level of the zone rectangle that contains a map point, if any. */
  const levelAt = (x: number, y: number): number | undefined => {
    for (const z of ctx.zoneBoxes) {
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return levelOfZone.get(z.id);
    }
    return undefined;
  };

  const layerLists = levels.map(emptyLists);
  const bridgeLists = emptyLists();
  /** The lists of a level, or the bridges for a thing that belongs to no level. */
  const into = (index: number | undefined): Lists => layerLists[index ?? -1] ?? bridgeLists;

  // Panels are listed in the layout's zone order.
  ctx.zoneBoxes.forEach((zone, i) => {
    const panel = view.panels[i];
    if (panel) into(levelOfZone.get(zone.id)).panels.push(panel);
  });

  // Links are listed in the content's link order, one segment each. A conduit is a bridge even
  // when both its ends hang in one level.
  view.links.forEach((link, i) => {
    const a = levelAt(link.x0, link.y0);
    const b = levelAt(link.x1, link.y1);
    const inside = ctx.links[i]?.conduit === "" && a !== undefined && a === b;
    into(inside ? a : undefined).links.push(link);
  });

  for (const node of view.nodes) into(levelAt(node.x, node.y)).nodes.push(node);
  for (const halo of view.halos) into(levelAt(halo.x, halo.y)).halos.push(halo);

  const railway = into(TRACK_LEVEL);
  railway.track.push(...view.track);
  railway.routes.push(...view.routes);
  railway.trains.push(...view.trains);
  railway.signals.push(...view.signals);

  bridgeLists.trail.push(...view.trail);
  bridgeLists.alerts.push(...view.alerts);
  bridgeLists.defenses.push(...view.defenses);
  bridgeLists.defenseArrows.push(...view.defenseArrows);

  const make = (lists: Lists): RenderView => ({ ...view, ...lists, ground: false });
  return { layers: layerLists.map(make), bridges: make(bridgeLists) };
}
