import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RelationshipCreatePopover } from "./RelationshipCreatePopover";

describe("RelationshipCreatePopover", () => {
  it("validates and saves a model-only relationship", async () => {
    const onValidate = vi.fn().mockResolvedValue({
      valid: true, compatible: true, duplicate: false, physicalExists: false,
      suggestedCardinality: "manyToOne", status: "active", messages: [],
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RelationshipCreatePopover
      sourceId="source"
      draft={{
        source: { schema: "public", table: "orders", columns: ["user_id"] },
        target: { schema: "public", table: "users", columns: ["id"] },
      }}
      onValidate={onValidate}
      onSave={onSave}
      onCancel={vi.fn()}
    />);

    expect(screen.getByText("MODEL ONLY · NO DATABASE CONSTRAINT")).toBeVisible();
    await waitFor(() => expect(onValidate).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Order owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "source",
      name: "orders_user_id_users_id",
      cardinality: "manyToOne",
      note: "Order owner",
      allowTypeMismatch: false,
    })));
  });

  it("requires explicit confirmation for a type mismatch", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RelationshipCreatePopover
      sourceId="source"
      draft={{ source: { schema: "public", table: "orders", columns: ["user_id"] }, target: { schema: "public", table: "users", columns: ["id"] } }}
      onValidate={vi.fn().mockResolvedValue({ valid: false, compatible: false, duplicate: false, physicalExists: false, suggestedCardinality: "manyToOne", status: "conflicted", messages: ["Source and target column types differ."] })}
      onSave={onSave}
      onCancel={vi.fn()}
    />);
    const create = screen.getByRole("button", { name: "Create" });
    await waitFor(() => expect(screen.getByText("Source and target column types differ.")).toBeVisible());
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Allow type mismatch/));
    expect(create).toBeEnabled();
  });
});
