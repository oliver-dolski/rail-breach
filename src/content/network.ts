import { conduits, interlockings, links, nodes, zones } from "./topology";
import { tracks } from "./tracks";
import type { Content } from "./types";

/** The whole fictional railway: cyber topology and track, ready for validateContent. */
export const network: Content = { zones, nodes, links, conduits, interlockings, tracks };
