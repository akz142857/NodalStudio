import { describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot, NodalStudioPlatform, SchemaChangeSet } from "../platform";
import { loadChangeImpacts } from "../graph/change-impact";

const snapshot = {
  id: "after",
  sourceId: "source",
  schemas: [{ name: "public", tables: [{ key: { kind: "table", schema: "public", name: "orders" }, columns: [{ name: "status" }] }, { key: { kind: "table", schema: "public", name: "payments" }, columns: [{ name: "status" }] }] }],
} as unknown as DatabaseSnapshot;

const changes = {
  beforeSnapshotId: "before",
  operations: [{ operationType: "alterColumn", object: { kind: "column", schema: "public.orders", name: "status" }, risk: "high", before: "text", after: "integer" }],
} as SchemaChangeSet;

describe("change impact", () => {
  it("keeps an exact parsed column usage as direct impact", async () => {
    const getDatabaseCodeUsage = vi.fn().mockResolvedValue({ nodes: [{ id: "query", kind: "query", qualifiedName: "queries/orders.sql#1" }], edges: [] });
    const platform = { getSnapshot: vi.fn().mockRejectedValue(new Error("old unavailable")), getDatabaseCodeUsage, getChangeImpact: vi.fn().mockResolvedValue([{ potential: false }]) } as unknown as NodalStudioPlatform;
    const result = await loadChangeImpacts(platform, snapshot, changes);
    expect(result).toHaveLength(1); expect(result[0]?.target.kind).toBe("column"); expect(result[0]?.potential).toBe(false); expect(getDatabaseCodeUsage).toHaveBeenCalledTimes(1);
  });

  it("falls back from a column to its owning table and marks the result potential", async () => {
    const getDatabaseCodeUsage = vi.fn()
      .mockResolvedValueOnce({ nodes: [], edges: [] })
      .mockResolvedValueOnce({ nodes: [{ id: "service", kind: "service", qualifiedName: "OrderService" }], edges: [] });
    const platform = {
      getSnapshot: vi.fn().mockRejectedValue(new Error("old snapshot unavailable")),
      getDatabaseCodeUsage,
      getChangeImpact: vi.fn().mockResolvedValue([]),
    } as unknown as NodalStudioPlatform;
    const result = await loadChangeImpacts(platform, snapshot, changes);
    expect(result).toHaveLength(1);
    expect(result[0]?.target.name).toBe("orders");
    expect(result[0]?.potential).toBe(true);
    expect(getDatabaseCodeUsage).toHaveBeenCalledTimes(2);
    expect(getDatabaseCodeUsage).toHaveBeenLastCalledWith("source", { kind: "table", schema: "public", name: "orders" });
  });
});
