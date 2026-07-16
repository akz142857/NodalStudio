import { describe, expect, it } from "vitest";
import type { TableNode } from "./schema-graph";
import { floatingRelationshipPanelPosition, relationshipEndpointFromHandle, sameRelationshipEndpoint } from "./relationship-interaction";

const nodes = [{
  id: "public.orders", type: "table", position: { x: 0, y: 0 },
  data: { schema: "public", table: { key: { kind: "table", schema: "public", name: "orders" }, tableKind: "ordinary", columns: [{ name: "user_id", ordinalPosition: 1, formattedType: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: false, defaultValue: null, identity: null, generated: false, comment: null }], primaryKey: null, foreignKeys: [], indexes: [], constraints: [], comment: null } },
}] satisfies TableNode[];

describe("relationship interaction", () => {
  it("maps field handles to stable relationship endpoints", () => {
    expect(relationshipEndpointFromHandle(nodes, "public.orders", "source:user_id:right")).toEqual({ schema: "public", table: "orders", columns: ["user_id"] });
    expect(relationshipEndpointFromHandle(nodes, "public.orders", "source:missing:right")).toBeUndefined();
  });

  it("rejects a field connected to itself", () => {
    const endpoint = { schema: "public", table: "orders", columns: ["user_id"] };
    expect(sameRelationshipEndpoint(endpoint, endpoint)).toBe(true);
    expect(sameRelationshipEndpoint(endpoint, { ...endpoint, columns: ["owner_id"] })).toBe(false);
  });

  it("places relationship details beside the line and flips away from viewport edges", () => {
    expect(floatingRelationshipPanelPosition({ x: 400, y: 400 }, { width: 1200, height: 800 })).toEqual({ left: 414, top: 190 });
    expect(floatingRelationshipPanelPosition({ x: 1150, y: 760 }, { width: 1200, height: 800 })).toEqual({ left: 816, top: 368 });
    expect(floatingRelationshipPanelPosition({ x: 5, y: 5 }, { width: 300, height: 300 }, { width: 260, height: 240 })).toEqual({ left: 19, top: 12 });
  });
});
