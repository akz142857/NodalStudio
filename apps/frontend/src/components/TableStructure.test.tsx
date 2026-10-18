import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TableAiEvidence } from "../platform";
import { aiTable, tableAiPreview } from "../test/table-ai-fixture";
import { TableStructure } from "./TableInspector";


describe("structural evidence navigation", () => {
  it.each([
    ["foreignKey", "orders_customer_fk", ["customer_id"]],
    ["index", "orders_customer_idx", ["customer_id", "total"]],
    ["constraint", "positive_total", ["total"]],
  ] as const)("focuses the %s object before its supporting columns", (kind, name, columns) => {
    const scrolled: Element[] = [];
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: function (this: HTMLElement) { scrolled.push(this); } });
    try {
      const evidence: TableAiEvidence = { ...tableAiPreview.context.evidence[0], objectKey: { kind, schema: "public.orders", name }, columns: [...columns] };
      const { container } = render(<TableStructure table={aiTable} focusedEvidence={evidence} />);
      const object = screen.getByText(name).closest("li");
      expect(object).toHaveFocus();
      expect(scrolled).toEqual([object]);
      for (const column of columns) {
        expect(screen.getByText(column, { selector: "strong" }).closest("[data-evidence-focus]")).toHaveAttribute("data-evidence-focus", "true");
      }
      expect(container.querySelector('[data-evidence-target="true"]')).toBe(object);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("retains direct field focus and falls back to columns for a primary key", () => {
    const evidence = tableAiPreview.context.evidence[0];
    const view = render(<TableStructure table={aiTable} focusedEvidence={evidence} />);
    expect(document.activeElement).toHaveTextContent("customer_id");
    view.rerender(<TableStructure table={aiTable} focusedEvidence={{ ...evidence, kind: "primaryKey", objectKey: { kind: "primaryKey", schema: "public.orders", name: "orders_pkey" }, columns: ["id"] }} />);
    expect(document.activeElement).toHaveTextContent("id");
    expect(document.activeElement).not.toHaveTextContent("customer_id");
  });
  it.each([["customer_id"], ["total", "customer_id"]])("locates the first logical mapping field and highlights the full mapping: %j", (...columns: string[]) => {
    const scrolled: Element[] = [];
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: function (this: HTMLElement) { scrolled.push(this); } });
    try {
      // The backend represents model-only relationships with a table key plus source columns.
      const evidence: TableAiEvidence = { ...tableAiPreview.context.evidence[0], kind: "logicalRelationship", objectKey: aiTable.key, columns };
      const { container } = render(<TableStructure table={aiTable} focusedEvidence={evidence} />);
      const field = screen.getByText(columns[0], { selector: "strong" }).closest(".inspector-columns > div");
      expect(field).toHaveFocus();
      expect(scrolled).toEqual([field]);
      expect(screen.getByText(aiTable.comment!)).not.toHaveFocus();
      expect(container.querySelector('[data-evidence-target="true"]')).toBe(field);
      for (const column of columns) {
        expect(screen.getByText(column, { selector: "strong" }).closest("[data-evidence-focus]")).toHaveAttribute("data-evidence-focus", "true");
      }
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it.each(["table", "databaseComment"])("preserves table-level navigation for %s evidence", (kind) => {
    const evidence: TableAiEvidence = { ...tableAiPreview.context.evidence[0], kind, objectKey: aiTable.key, columns: [] };
    render(<TableStructure table={aiTable} focusedEvidence={evidence} />);
    expect(screen.getByText(aiTable.comment!)).toHaveFocus();
  });

});
