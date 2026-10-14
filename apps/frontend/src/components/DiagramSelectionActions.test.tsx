import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DomainGroup } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { DiagramSelectionActions, type DiagramSelectionActionsProps } from "./DiagramSelectionActions";

function props(): DiagramSelectionActionsProps {
  return { snapshot: reportSnapshot, domainGroups: reportSemantics.domainGroups, selectedCount: 2,
    selectedTableKeys: [reportSnapshot.schemas[0].tables[1].key, reportSnapshot.schemas[1].tables[0].key], onClear: vi.fn(),
    onAddTablesToDomain: vi.fn().mockResolvedValue(reportSemantics.domainGroups[0]) };
}

describe("DiagramSelectionActions", () => {
  it("requires an existing domain, adds the selected tables once and reports new versus existing members", async () => {
    const input = props();
    render(<DiagramSelectionActions {...input} />);
    expect(screen.getByText("2 tables selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add to domain" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Existing business domain" }), { target: { value: input.domainGroups[0].id } });
    fireEvent.click(screen.getByRole("button", { name: "Add to domain" }));
    await waitFor(() => expect(input.onAddTablesToDomain).toHaveBeenCalledExactlyOnceWith(input.domainGroups[0].id, input.selectedTableKeys));
    expect(await screen.findByRole("status")).toHaveTextContent("Added 1 table to Commerce. 1 already in the domain.");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(input.onClear).toHaveBeenCalledOnce();
  });

  it("does not save when all selected tables already belong to the domain", () => {
    const input = { ...props(), selectedTableKeys: reportSemantics.domainGroups[0].tableKeys };
    render(<DiagramSelectionActions {...input} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: input.domainGroups[0].id } });
    expect(screen.getByText("All selected tables already belong to Commerce.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add to domain" })).toBeDisabled();
    expect(input.onAddTablesToDomain).not.toHaveBeenCalled();
  });

  it("blocks duplicate saves while pending, reports errors and supports retry", async () => {
    let finish!: (group: DomainGroup) => void;
    const save = vi.fn<NonNullable<DiagramSelectionActionsProps["onAddTablesToDomain"]>>().mockRejectedValueOnce(new Error("Local store unavailable")).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const input = { ...props(), onAddTablesToDomain: save };
    render(<DiagramSelectionActions {...input} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: input.domainGroups[0].id } });
    fireEvent.click(screen.getByRole("button", { name: "Add to domain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Local store unavailable");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry domain update" }));
    expect(screen.getByRole("status")).toHaveTextContent("Running · Adding 1 table to Commerce");
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Adding…" }));
    await act(() => Promise.resolve(finish(input.domainGroups[0])));
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not display a late domain result for a changed table selection", async () => {
    let finish!: (group: DomainGroup) => void;
    const input = { ...props(), onAddTablesToDomain: vi.fn(() => new Promise<DomainGroup>((resolve) => { finish = resolve; })) };
    const { rerender } = render(<DiagramSelectionActions {...input} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: input.domainGroups[0].id } });
    fireEvent.click(screen.getByRole("button", { name: "Add to domain" }));
    rerender(<DiagramSelectionActions {...input} selectedCount={1} selectedTableKeys={[input.selectedTableKeys[0]]} />);
    await act(() => Promise.resolve(finish(input.domainGroups[0])));
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("handles missing domains, unavailable semantics, comparison and Web read-only diagrams", () => {
    const input = props();
    const { rerender } = render(<DiagramSelectionActions {...input} domainGroups={[]} />);
    expect(screen.getByText(/Create a business domain/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add to domain" })).toBeDisabled();
    rerender(<DiagramSelectionActions {...input} onAddTablesToDomain={undefined} />);
    expect(screen.getByText(/must finish loading/)).toBeVisible();
    rerender(<DiagramSelectionActions {...input} readOnlyReason="Comparison diagrams are read only." />);
    expect(screen.getByText("Comparison diagrams are read only.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add to domain" })).not.toBeInTheDocument();
    rerender(<DiagramSelectionActions {...input} readOnlyReason="Shared diagrams are read only." />);
    expect(screen.getByText("Shared diagrams are read only.")).toBeVisible();
    expect(input.onAddTablesToDomain).not.toHaveBeenCalled();
  });
});
