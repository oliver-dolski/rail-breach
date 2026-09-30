import type { Content, LinkDef } from "../../content/types";

/** One step along a link, seen from a node. */
export interface Neighbour {
  node: string;
  link: LinkDef;
}

/** Adjacency of the cyber graph, built once. Never part of World. */
export interface NetIndex {
  /** Sorted node ids. */
  nodes: string[];
  /** Neighbours of each node, sorted by (neighbour id, link id) so searches are deterministic. */
  adjacency: Map<string, Neighbour[]>;
}

export interface NetPath {
  /** Node ids from start to goal, both included. */
  nodes: string[];
  /** Link ids between consecutive nodes. */
  links: string[];
}

/** Decides whether traffic may cross a link in a direction; defenses plug in here. */
export type LinkFilter = (link: LinkDef, from: string, to: string) => boolean;

/**
 * Builds the adjacency lists. Links naming an unknown node are skipped, so the
 * builder can run on content that validateContent is still checking.
 */
export function buildNetIndex(content: Pick<Content, "nodes" | "links">): NetIndex {
  const nodes = content.nodes.map((n) => n.id).sort();
  const known = new Set(nodes);
  const adjacency = new Map<string, Neighbour[]>();
  for (const id of nodes) adjacency.set(id, []);
  for (const link of content.links) {
    if (!known.has(link.a) || !known.has(link.b)) continue;
    adjacency.get(link.a)?.push({ node: link.b, link });
    adjacency.get(link.b)?.push({ node: link.a, link });
  }
  for (const list of adjacency.values()) {
    list.sort((x, y) =>
      x.node !== y.node ? (x.node < y.node ? -1 : 1) : x.link.id < y.link.id ? -1 : 1,
    );
  }
  return { nodes, adjacency };
}

/** Every node reachable from any start node. */
export function reachableFrom(
  net: NetIndex,
  starts: readonly string[],
  filter?: LinkFilter,
): Set<string> {
  const reached = new Set<string>(starts);
  const queue = [...starts];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    if (at === undefined) continue;
    for (const { node, link } of net.adjacency.get(at) ?? []) {
      if (reached.has(node)) continue;
      if (filter !== undefined && !filter(link, at, node)) continue;
      reached.add(node);
      queue.push(node);
    }
  }
  return reached;
}

/**
 * Breadth-first shortest path. Ties are broken by the sorted adjacency, so the
 * same graph always gives the same path.
 */
export function findPath(
  net: NetIndex,
  from: string,
  to: string,
  filter?: LinkFilter,
): NetPath | null {
  if (!net.adjacency.has(from) || !net.adjacency.has(to)) return null;
  if (from === to) return { nodes: [from], links: [] };
  const via = new Map<string, { prev: string; link: string }>();
  const seen = new Set<string>([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    if (at === undefined) continue;
    for (const { node, link } of net.adjacency.get(at) ?? []) {
      if (seen.has(node)) continue;
      if (filter !== undefined && !filter(link, at, node)) continue;
      seen.add(node);
      via.set(node, { prev: at, link: link.id });
      if (node === to) return unwind(via, from, to);
      queue.push(node);
    }
  }
  return null;
}

function unwind(
  via: Map<string, { prev: string; link: string }>,
  from: string,
  to: string,
): NetPath {
  const nodes = [to];
  const links: string[] = [];
  let at = to;
  while (at !== from) {
    const step = via.get(at);
    if (step === undefined) break;
    links.unshift(step.link);
    nodes.unshift(step.prev);
    at = step.prev;
  }
  return { nodes, links };
}
