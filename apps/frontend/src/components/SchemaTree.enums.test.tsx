import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SchemaTree } from "./SchemaTree";
import { enumSnapshot } from "../test/enum-fixture";

function openEnum(schema = "public") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${schema}`) }));
  fireEvent.click(screen.getByRole("button", { name: /^Enums/ }));
  fireEvent.click(screen.getByRole("button", { name: "order_status" }));
  return screen.getByRole("region", { name: `Enum details for ${schema}.order_status` });
}

it("shows every value in declaration order safely, groups all referencing fields and keeps details available for repeated location", () => {
  const select = vi.fn();
  render(<SchemaTree snapshot={enumSnapshot} onSelectTable={select} />);
  const details = openEnum();
  expect(within(details).getAllByRole("listitem").slice(0, 5).map((li) => li.textContent)).toEqual(enumSnapshot.schemas[0].enums[0].values.map((value) => JSON.stringify(value)));
  expect(details.querySelector("script")).toBeNull();
  expect(details).toHaveTextContent("Used by 2 tables · 4 fields");
  for (const name of ["status", "previous_status", "history", "public_status"]) expect(details).toHaveTextContent(name);
  expect(details).not.toHaveTextContent("other_status"); expect(details).not.toHaveTextContent("not_an_enum");
  expect(select).not.toHaveBeenCalled();
  // Sidebar filtering never narrows the full-snapshot usage inventory.
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "customers" } });
  fireEvent.click(within(details).getByRole("button", { name: "Locate archive.orders in diagram" }));
  expect(select).toHaveBeenLastCalledWith(enumSnapshot.schemas[1].tables[0]);
  fireEvent.click(within(details).getByRole("button", { name: "Locate public.orders in diagram" }));
  expect(select).toHaveBeenLastCalledWith(enumSnapshot.schemas[0].tables[1]);
  expect(details).toBeVisible(); expect(select).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(details, { key: "Escape" });
  expect(screen.queryByRole("region", { name: /Enum details/ })).not.toBeInTheDocument();
  expect(screen.getByRole("searchbox")).toHaveFocus();
});

it("distinguishes enum/view objects with the same name and supports enum context actions and close focus", () => {
  render(<SchemaTree snapshot={enumSnapshot} onSelectTable={vi.fn()} />);
  openEnum();
  const enumRow = screen.getByRole("button", { name: "order_status" });
  expect(enumRow).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Close enum details" }));
  expect(enumRow).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${enumSnapshot.schemas[0].name}.order_status` }));
  const menu = screen.getByRole("menu", { name: "Actions for public.order_status" });
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Show enum details", "Copy qualified name"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Show enum details" }));
  expect(screen.getByRole("region", { name: /Enum details/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^Views/ }));
  const views = screen.getByRole("button", { name: /^Views/ }).parentElement!;
  fireEvent.click(within(views).getByRole("button", { name: "order_status" }));
  expect(screen.getByRole("region", { name: "Definition of public.order_status" })).toHaveTextContent("SELECT 1");
  expect(screen.queryByRole("region", { name: /Enum details/ })).not.toBeInTheDocument();
  fireEvent.click(enumRow);
  expect(screen.queryByRole("region", { name: /Definition of/ })).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("region", { name: /Enum details/ }), { key: "Escape" });
  expect(enumRow).toHaveFocus();
});

it("uses current snapshot values and references on refresh, removes deleted details and clears them when switching sources", () => {
  const select = vi.fn();
  const { rerender } = render(<SchemaTree snapshot={enumSnapshot} onSelectTable={select} />);
  openEnum();
  const changed = { ...enumSnapshot, id: "refreshed", schemas: enumSnapshot.schemas.map((schema) => ({ ...schema,
    tables: [], enums: schema.enums.map((item) => ({ ...item, values: ["updated"] })),
  })) };
  rerender(<SchemaTree snapshot={changed} onSelectTable={select} />);
  const details = screen.getByRole("region", { name: /Enum details/ });
  expect(details).toHaveTextContent('"updated"'); expect(details).not.toHaveTextContent('"paid"');
  expect(details).toHaveTextContent("No captured table fields use this enum.");
  expect(within(details).queryByRole("button", { name: /Locate/ })).not.toBeInTheDocument();
  rerender(<SchemaTree snapshot={{ ...changed, schemas: changed.schemas.map((schema) => ({ ...schema, enums: [] })) }} onSelectTable={select} />);
  expect(screen.queryByRole("region", { name: /Enum details/ })).not.toBeInTheDocument();
  rerender(<SchemaTree snapshot={enumSnapshot} onSelectTable={select} />);
  expect(screen.queryByRole("region", { name: /Enum details/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "order_status" }));
  rerender(<SchemaTree snapshot={{ ...enumSnapshot, sourceId: "another-source" }} onSelectTable={select} />);
  expect(screen.queryByRole("region", { name: /Enum details/ })).not.toBeInTheDocument();
  expect(select).not.toHaveBeenCalled();
});

it("shows another schema's enum separately and reports empty declarations without guessing dependencies", () => {
  const { rerender } = render(<SchemaTree snapshot={enumSnapshot} onSelectTable={vi.fn()} />);
  const details = openEnum("archive");
  expect(details).toHaveTextContent('"archived"'); expect(details).not.toHaveTextContent('"new"');
  expect(details).toHaveTextContent("Used by 2 tables · 2 fields");
  const unused = { ...enumSnapshot, sourceId: "empty-source", schemas: [{ ...enumSnapshot.schemas[0], tables: [], enums: [{ key: { kind: "enum" as const, schema: "public", name: "unused" }, values: [] }] }] };
  rerender(<SchemaTree snapshot={unused} onSelectTable={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /^Enums/ })); fireEvent.click(screen.getByRole("button", { name: "unused" }));
  const empty = screen.getByRole("region", { name: "Enum details for public.unused" });
  expect(empty).toHaveTextContent("No values recorded in this snapshot.");
  expect(empty).toHaveTextContent("Used by 0 tables · 0 fields");
});
