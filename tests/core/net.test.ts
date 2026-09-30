import { describe, expect, it } from "vitest";
import { network } from "../../src/content/network";
import { buildNetIndex, findPath, reachableFrom } from "../../src/core/net/graph";

const net = buildNetIndex(network);

describe("net graph", () => {
  it("finds a shortest path from the internet to the wayside controller of an interlocking", () => {
    const path = findPath(net, "internet", "oc-vel");
    expect(path).not.toBeNull();
    expect(path?.nodes[0]).toBe("internet");
    expect(path?.nodes.at(-1)).toBe("oc-vel");
    expect(path?.nodes).toContain("il-vel");
    expect(path?.links.length).toBe((path?.nodes.length ?? 0) - 1);
  });

  it("gives the same path every time and does not depend on content order", () => {
    const shuffled = buildNetIndex({
      nodes: [...network.nodes].reverse(),
      links: [...network.links].reverse(),
    });
    const a = findPath(net, "internet", "oc-cre");
    expect(findPath(net, "internet", "oc-cre")).toEqual(a);
    expect(findPath(shuffled, "internet", "oc-cre")).toEqual(a);
  });

  it("respects a link filter, which is how a defense will block a path", () => {
    const blocked = new Set(["c-net-corp", "c-net-vendor"]);
    const open = (link: { conduit?: string }): boolean => !blocked.has(link.conduit ?? "");
    expect(findPath(net, "internet", "oc-vel", open)).toBeNull();
    expect(reachableFrom(net, ["internet"], open).size).toBe(1);
  });

  it("returns null for unknown nodes and a trivial path from a node to itself", () => {
    expect(findPath(net, "internet", "nowhere")).toBeNull();
    expect(findPath(net, "fep", "fep")).toEqual({ nodes: ["fep"], links: [] });
  });

  it("reaches every node from the internet", () => {
    expect(reachableFrom(net, ["internet"]).size).toBe(network.nodes.length);
  });
});
