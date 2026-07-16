import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogicalRelationship } from "../../platform";
import { RelationshipManager } from "./RelationshipManager";

const relationship: LogicalRelationship = {
  id: "relation", sourceId: "source", name: "orders_owner",
  source: { schema: "public", table: "orders", columns: ["user_id"] },
  target: { schema: "public", table: "users", columns: ["id"] },
  cardinality: "manyToOne", status: "orphaned", origin: "manual", note: null,
  evidence: [], createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z",
};

afterEach(cleanup);

describe("RelationshipManager", () => {
  it("keeps invalid relationships available for rebind and deletion", () => {
    const onRebindTarget = vi.fn();
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<RelationshipManager relationships={[relationship]} onSelect={onSelect} onEdit={vi.fn()} onRebindTarget={onRebindTarget} onToggle={vi.fn()} onDelete={onDelete} onClose={onClose} />);
    expect(screen.getByText("Missing endpoint")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show on canvas" }));
    expect(onSelect).toHaveBeenCalledWith(relationship);
    fireEvent.click(screen.getByRole("button", { name: "Rebind target" }));
    expect(onRebindTarget).toHaveBeenCalledWith(relationship);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(relationship);
    expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("searches endpoints and exposes status filters without horizontal content", () => {
    const active = { ...relationship, id: "active", name: "payments_owner", status: "active" as const, source: { schema: "billing", table: "payments", columns: ["owner_id"] } };
    render(<RelationshipManager relationships={[relationship, active]} onSelect={vi.fn()} onEdit={vi.fn()} onRebindTarget={vi.fn()} onToggle={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Relationship, table, or field…"), { target: { value: "billing.payments" } });
    expect(screen.getByText("payments_owner")).toBeVisible();
    expect(screen.queryByText("orders_owner")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Relationship, table, or field…"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Needs attention 1" }));
    expect(screen.getByText("orders_owner")).toBeVisible();
    expect(screen.queryByText("payments_owner")).not.toBeInTheDocument();
  });
});
