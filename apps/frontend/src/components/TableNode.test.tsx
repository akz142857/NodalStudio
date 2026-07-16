import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TableNode as TableNodeType } from "../graph/schema-graph";
import { CanvasInteractionProvider } from "./CanvasInteractionContext";
import { TableNode } from "./TableNode";

describe("TableNode", () => {
  it("shows physical FK fields and collected indexes", () => {
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 140 : this.classList.contains("table-node") ? 20 : 0;
    });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 28 : 0;
    });
    const props = {
      id: "public.orders",
      type: "table",
      selected: true,
      dragging: false,
      zIndex: 0,
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        schema: "public",
        table: {
          key: { kind: "table", schema: "public", name: "orders" },
          tableKind: "ordinary",
          columns: [{
            name: "user_id", ordinalPosition: 1, formattedType: "uuid",
            typeSchema: "pg_catalog", typeName: "uuid", nullable: false,
            defaultValue: null, identity: null, generated: false, comment: null,
          }],
          primaryKey: null,
          foreignKeys: [{
            name: "orders_user_fk", columns: ["user_id"], referencedSchema: "public",
            referencedTable: "users", referencedColumns: ["id"], onUpdate: "noAction",
            onDelete: "cascade", matchType: "simple", deferrable: false,
            initiallyDeferred: false,
          }],
          indexes: [{
            name: "orders_user_idx", method: "btree", columns: ["user_id"],
            unique: false, primary: false, predicate: null,
          }],
          constraints: [],
          comment: null,
        },
      },
    } as unknown as NodeProps<TableNodeType>;

    const { container } = render(<ReactFlowProvider><TableNode {...props} /></ReactFlowProvider>);

    expect(screen.getByTitle("Physical foreign key")).toHaveTextContent("FK");
    expect(screen.getByText("orders_user_idx")).toBeVisible();
    expect(screen.getAllByText("IX")).toHaveLength(2);
    expect(screen.getByTitle("Index member")).toBeVisible();
    expect(container.querySelector('[data-handleid="source:user_id:left"]')).toBeInTheDocument();
    expect(container.querySelector('[data-handleid="source:user_id:right"]')).toBeInTheDocument();
    expect(container.querySelector(".table-node")?.contains(container.querySelector('[data-handleid="source:user_id:left"]'))).toBe(false);
    expect(container.querySelector('[data-handleid="source:user_id:left"]')?.parentElement).toHaveClass("field-handle-row");
    expect(container.querySelector<HTMLElement>(".field-handle-row")?.style.top).toBe("134px");
    expect(container.querySelectorAll(".table-resize-handle")).toHaveLength(4);
    expect(container.querySelectorAll(".table-resize-line")).toHaveLength(4);

    const editableProps = { ...props, data: { ...props.data, relationshipsEditable: true } } as NodeProps<TableNodeType>;
    const editable = render(<ReactFlowProvider><TableNode {...editableProps} /></ReactFlowProvider>);
    expect(editable.container.querySelector('[data-handleid="target:user_id:left"]')).toBeInTheDocument();
    expect(editable.container.querySelector('[data-handleid="source:user_id:right"]')).toHaveClass("field-handle-source");

    const panMode = render(<ReactFlowProvider><CanvasInteractionProvider value={{ spacePanMode: true }}><TableNode {...props} /></CanvasInteractionProvider></ReactFlowProvider>);
    expect(panMode.container.querySelectorAll(".table-resize-handle")).toHaveLength(0);
    offsetTop.mockRestore();
    offsetHeight.mockRestore();
  });
});
