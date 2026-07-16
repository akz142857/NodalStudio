import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot, TableDefinition } from "../../platform";
import { RelationshipTargetPicker } from "./RelationshipTargetPicker";

function table(name: string, column: string): TableDefinition {
  return { key: { kind: "table", schema: "public", name }, tableKind: "ordinary", columns: [{ name: column, ordinalPosition: 1, formattedType: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: false, defaultValue: null, identity: null, generated: false, comment: null }], primaryKey: null, foreignKeys: [], indexes: [], constraints: [], comment: null };
}

const snapshot: DatabaseSnapshot = { id: "snapshot", sourceId: "source", capturedAt: "2026-07-12T00:00:00Z", fingerprint: "fp", database: { name: "app", databaseType: "postgreSql", version: "17" }, schemas: [{ name: "public", tables: [table("orders", "user_id"), table("users", "id")], views: [], enums: [] }] };

describe("RelationshipTargetPicker", () => {
  it("searches schema table and field and selects a compatible target", () => {
    const onSelect = vi.fn();
    render(<RelationshipTargetPicker snapshot={snapshot} source={{ schema: "public", table: "orders", columns: ["user_id"] }} onSelect={onSelect} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search target field"), { target: { value: "users.id" } });
    const result = screen.getByRole("option");
    expect(result).toHaveTextContent("compatible");
    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledWith({ schema: "public", table: "users", columns: ["id"] });
  });
});
