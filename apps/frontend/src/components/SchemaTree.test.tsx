import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot } from "../platform";
import { SchemaTree } from "./SchemaTree";

function table(name: string) {
  return {
    key: { kind: "table", schema: "public", name },
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
    primaryKey: null,
    foreignKeys: [],
    indexes: [],
    constraints: [],
    comment: null,
  };
}

const snapshot = {
  id: "snapshot",
  sourceId: "source",
  capturedAt: "2026-08-30T00:00:00Z",
  fingerprint: "abcdef123456",
  database: { name: "flow", databaseType: "postgres" },
  schemas: [
    {
      name: "public",
      tables: [table("orders"), table("customers")],
      views: [{ key: { kind: "view", schema: "public", name: "order_totals" } }],
      enums: [],
    },
  ],
} as unknown as DatabaseSnapshot;

describe("SchemaTree", () => {
  it("keeps objects out of the DOM until their type node is opened", () => {
    // A flat list of every table is what made the sidebar thousands of pixels
    // tall, so the tables must not be mounted just because a schema is.
    render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);

    // Single schema opens itself, but its type nodes stay closed.
    expect(screen.getByRole("button", { name: /public/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("orders")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    expect(screen.getByText("orders")).toBeVisible();
    expect(screen.getByText("customers")).toBeVisible();
    // Opening Tables must not drag the other types in with it.
    expect(screen.queryByText("order_totals")).not.toBeInTheDocument();
  });

  it("counts every object type, not just tables", () => {
    render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);
    expect(screen.getByRole("button", { name: /public/ })).toHaveTextContent("3");
  });

  it("disables a type node that has nothing behind it", () => {
    render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Enums/ })).toBeDisabled();
  });

  it("reports the chosen table and marks it as current", () => {
    const onSelectTable = vi.fn();
    const { rerender } = render(
      <SchemaTree snapshot={snapshot} onSelectTable={onSelectTable} />,
    );

    const [orders] = snapshot.schemas[0].tables;
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    fireEvent.click(screen.getByRole("button", { name: /orders/ }));
    expect(onSelectTable).toHaveBeenCalledWith(orders);

    rerender(
      <SchemaTree snapshot={snapshot} selectedTable={orders} onSelectTable={onSelectTable} />,
    );
    expect(screen.getByRole("button", { name: /orders/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
