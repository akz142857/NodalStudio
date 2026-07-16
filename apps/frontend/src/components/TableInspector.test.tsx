import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SaveAnnotationInput, TableDefinition } from "../platform";
import { TableInspector } from "./TableInspector";

const table: TableDefinition = {
  key: { kind: "table", schema: "public", name: "users" },
  tableKind: "ordinary",
  columns: [
    {
      name: "id",
      ordinalPosition: 1,
      formattedType: "uuid",
      typeSchema: "pg_catalog",
      typeName: "uuid",
      nullable: false,
      defaultValue: null,
      identity: null,
      generated: false,
      comment: null,
    },
  ],
  primaryKey: { name: "users_pkey", columns: ["id"] },
  foreignKeys: [],
  indexes: [],
  constraints: [],
  comment: null,
};

describe("TableInspector", () => {
  it("saves normalized team knowledge for a table", async () => {
    const save = vi.fn<(input: SaveAnnotationInput) => Promise<void>>().mockResolvedValue();
    render(
      <TableInspector
        table={table}
        sourceId="source"
        onSaveAnnotation={save}
      />,
    );

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Canonical user accounts" },
    });
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "identity, core" },
    });
    fireEvent.click(screen.getByLabelText("Mark as a core table"));
    fireEvent.click(screen.getByRole("button", { name: "Save knowledge" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source",
        objectKey: table.key,
        description: "Canonical user accounts",
        tags: ["identity", "core"],
        isCore: true,
      }),
    );
  });
});
