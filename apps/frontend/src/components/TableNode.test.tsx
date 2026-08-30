import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("only mounts handles for relationship columns, revealing the rest on hover or while connecting", () => {
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 140 : this.classList.contains("table-node") ? 20 : 0;
    });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 28 : 0;
    });
    const column = (name: string) => ({
      name, ordinalPosition: 1, formattedType: "uuid",
      typeSchema: "pg_catalog", typeName: "uuid", nullable: false,
      defaultValue: null, identity: null, generated: false, comment: null,
    });
    const props = {
      id: "public.orders",
      type: "table",
      selected: false,
      dragging: false,
      zIndex: 0,
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        schema: "public",
        // Editable is the expensive case: it used to force four handles onto
        // every column of every table.
        relationshipsEditable: true,
        table: {
          key: { kind: "table", schema: "public", name: "orders" },
          tableKind: "ordinary",
          columns: [column("user_id"), column("note")],
          primaryKey: null,
          foreignKeys: [{
            name: "orders_user_fk", columns: ["user_id"], referencedSchema: "public",
            referencedTable: "users", referencedColumns: ["id"], onUpdate: "noAction",
            onDelete: "cascade", matchType: "simple", deferrable: false,
            initiallyDeferred: false,
          }],
          indexes: [],
          constraints: [],
          comment: null,
        },
      },
    } as unknown as NodeProps<TableNodeType>;

    // `user_id` carries the FK, `note` carries nothing.
    const { container } = render(<ReactFlowProvider><TableNode {...props} /></ReactFlowProvider>);
    expect(container.querySelector('[data-handleid="source:user_id:left"]')).toBeInTheDocument();
    expect(container.querySelector('[data-handleid="source:note:left"]')).not.toBeInTheDocument();

    // Hovering the bare column mounts its handles so a drag can start there.
    const noteRow = container.querySelector('[data-column-name="note"]');
    expect(noteRow).not.toBeNull();
    fireEvent.mouseEnter(noteRow as Element);
    expect(container.querySelector('[data-handleid="source:note:left"]')).toBeInTheDocument();

    // While a relationship is being connected every column must be droppable.
    const connecting = {
      ...props,
      data: { ...props.data, relationshipConnectTargets: { user_id: "valid", note: "warning" } },
    } as unknown as NodeProps<TableNodeType>;
    const dropTargets = render(<ReactFlowProvider><TableNode {...connecting} /></ReactFlowProvider>);
    expect(dropTargets.container.querySelector('[data-handleid="target:note:left"]')).toBeInTheDocument();

    offsetTop.mockRestore();
    offsetHeight.mockRestore();
  });

  it("exposes the domain colour as a custom property instead of a border override", () => {
    const props = {
      id: "public.orders",
      type: "table",
      selected: false,
      dragging: false,
      zIndex: 0,
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        schema: "public",
        domainColor: "#ff00aa",
        changeStatus: "added",
        table: {
          key: { kind: "table", schema: "public", name: "orders" },
          tableKind: "ordinary",
          columns: [],
          primaryKey: null,
          foreignKeys: [],
          indexes: [],
          constraints: [],
          comment: null,
        },
      },
    } as unknown as NodeProps<TableNodeType>;

    const { container } = render(<ReactFlowProvider><TableNode {...props} /></ReactFlowProvider>);
    const node = container.querySelector<HTMLElement>(".table-node");
    expect(node).toHaveAttribute("data-domain", "true");
    expect(node?.style.getPropertyValue("--domain-color")).toBe("#ff00aa");
    // The change-status border must survive: domain colour lives on its own channels.
    expect(node?.style.borderTopColor).toBe("");
    expect(node).toHaveAttribute("data-change", "added");
  });
});
