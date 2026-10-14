import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CapabilitiesMatrix } from "./CapabilitiesMatrix";
import { reportSnapshot } from "../test/schema-report-fixture";
describe("CapabilitiesMatrix", () => {
  it("shows four combinations, highlights the current context and explains SQL scope", () => {
    render(<CapabilitiesMatrix runtime={{ kind: "desktop", label: "Desktop", version: "test" }} database={reportSnapshot.database} />);
    const table = screen.getByRole("table"); expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(within(table).getByRole("columnheader", { name: "Desktop · PostgreSQL Current" })).toHaveAttribute("data-current", "true");
    const row = within(table).getByRole("row", { name: /Read-only SQL execution/ });
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Supported", "Unavailable", "Unavailable", "Unavailable"]);
    const details = screen.getByRole("region", { name: "Capability details" });
    expect(details).toHaveTextContent("maximum 5,000"); expect(details).toHaveTextContent("MySQL metadata capture is supported, but SQL execution is currently PostgreSQL-only");
  });
  it("updates context without assuming PostgreSQL when no database is loaded", () => {
    const { rerender, container } = render(<CapabilitiesMatrix />);
    expect(screen.getByText(/Current context/)).toHaveTextContent("Runtime not detected · No loaded database");
    expect(container.querySelector("[data-current=true]")).toBeNull();
    rerender(<CapabilitiesMatrix runtime={{ kind: "web", label: "Web", version: "test" }} database={{ ...reportSnapshot.database, databaseType: "mySql", version: "8.4" }} />);
    expect(screen.getByText(/Current context/)).toHaveTextContent("Web · MySQL 8.4");
    expect(screen.getByRole("columnheader", { name: "Web · MySQL Current" })).toHaveAttribute("data-current", "true");
  });
  it("filters by scope text and status, selects explanations and handles empty results", () => {
    render(<CapabilitiesMatrix />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search capabilities" }), { target: { value: "collation" } });
    expect(screen.getByRole("button", { name: "Structure preflight" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    expect(screen.getByRole("region", { name: "Capability details" })).toHaveTextContent("No database-validity guarantee");
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "supported" } });
    expect(screen.queryByRole("button", { name: "Structure preflight" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search capabilities" }), { target: { value: "zz-no-feature" } });
    expect(screen.getByText(/No capabilities match/)).toBeVisible(); expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
