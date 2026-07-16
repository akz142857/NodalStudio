import { describe, expect, it } from "vitest";
import { packLayoutComponents, splitLayoutComponents } from "./layout-components";

describe("component-aware schema layout", () => {
  it("keeps related tables together and separates disconnected groups", () => {
    const nodes = ["users", "orders", "products", "audit"].map((id) => ({ id, width: 200, height: 100 }));
    const components = splitLayoutComponents(nodes, [
      { id: "user-orders", source: "orders", target: "users" },
      { id: "order-products", source: "orders", target: "products" },
    ]);
    expect(components.map((component) => component.nodes.map((node) => node.id))).toEqual([
      ["users", "orders", "products"],
      ["audit"],
    ]);
  });

  it("packs component bounds without overlap", () => {
    const positions = packLayoutComponents([
      [{ id: "large", x: 0, y: 0, width: 600, height: 300 }],
      [{ id: "small", x: 0, y: 0, width: 200, height: 100 }],
    ], 100);
    expect(positions.large).toEqual({ x: 0, y: 0 });
    expect(positions.small.x >= 700 || positions.small.y >= 400).toBe(true);
  });
});
