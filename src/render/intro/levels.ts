import type { Layout } from "../../content/layout";
import type { Content, Zone } from "../../content/types";
import type { Rect } from "./pose";

/**
 * The five levels the intro hangs in the air. They are read from the `purdue` field of the
 * content zones, never from a list of zone ids written here, so a renamed or moved zone cannot
 * leave the intro showing something the network does not have.
 */

/** On-screen names, top to bottom. The double spaces are part of the contract. */
export const INTRO_LEVEL_NAMES: readonly string[] = [
  "LEVELS 4-5 AND OUTSIDE",
  "LEVEL 3.5  DMZ",
  "LEVEL 3  CONTROL CENTRE",
  "LEVEL 2  INTERLOCKINGS",
  "LEVEL 1  TRACKSIDE",
];

/** The level of the trackside zones: where the railway itself (track, signals, trains) hangs. */
export const TRACK_LEVEL = INTRO_LEVEL_NAMES.length - 1;

/** Room kept around the zones of a level on its plate, in map units. */
const PLATE_PAD = 14;
/** The plate stops this far short of the sheet's left and right edge. */
const PLATE_MARGIN_X = 8;

/** Which level a Purdue level hangs in: outside, 5 and 4 together, then one level each. */
export function levelOfPurdue(purdue: Zone["purdue"]): number {
  switch (purdue) {
    case "ext":
    case 5:
    case 4:
      return 0;
    case 3.5:
      return 1;
    case 3:
      return 2;
    case 2:
      return 3;
    case 1:
      return 4;
    default:
      throw new Error(`the intro has no level for Purdue level ${String(purdue)}`);
  }
}

export interface IntroLevel {
  /** 0 is the top of the stack. */
  index: number;
  name: string;
  /** The layout zones that hang in this level, in layout order. */
  zoneIds: string[];
  /** The bounding rectangle of those zones, in map units. */
  box: Rect;
  /** The pane the level hangs on: across the sheet, a little taller than the box. */
  plate: Rect;
}

export function introLevels(content: Content, layout: Layout): IntroLevel[] {
  const zoneIds: string[][] = INTRO_LEVEL_NAMES.map(() => []);
  const purdueOf = new Map(content.zones.map((z) => [z.id, z.purdue]));
  for (const zone of layout.zones) {
    const purdue = purdueOf.get(zone.id);
    if (purdue === undefined)
      throw new Error(`the layout has a zone the content lacks: ${zone.id}`);
    zoneIds[levelOfPurdue(purdue)]?.push(zone.id);
  }
  return INTRO_LEVEL_NAMES.map((name, index) => {
    const ids = zoneIds[index] ?? [];
    const zones = layout.zones.filter((z) => ids.includes(z.id));
    if (zones.length === 0) throw new Error(`intro level ${name} holds no zone`);
    const x0 = Math.min(...zones.map((z) => z.x));
    const y0 = Math.min(...zones.map((z) => z.y));
    const x1 = Math.max(...zones.map((z) => z.x + z.w));
    const y1 = Math.max(...zones.map((z) => z.y + z.h));
    const py0 = Math.max(0, y0 - PLATE_PAD);
    const py1 = Math.min(layout.height, y1 + PLATE_PAD);
    const px0 = Math.min(x0, PLATE_MARGIN_X);
    const px1 = Math.max(x1, layout.width - PLATE_MARGIN_X);
    return {
      index,
      name,
      zoneIds: ids,
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      plate: { x: px0, y: py0, w: px1 - px0, h: py1 - py0 },
    };
  });
}
