import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CodeExtension, CodeExtensionPlatform } from "../../platform/code-review";
import { CodeReviewExtensions } from "./CodeReviewExtensions";

it("opens a package from its row and runs management actions from the focused menu", async () => {
  const item: CodeExtension = {
    id: "example.syntax", name: "Example Syntax", publisher: "example", version: "1.0.0", description: "Highlights source code",
    fileName: "example.syntax-1.0.0.vsix", sha256: "test", source: "local", engine: "^1.90.0", capability: "syntax",
    enabled: true, languages: [],
  };
  const disabled = { ...item, enabled: false };
  const change = vi.fn<CodeExtensionPlatform["change"]>().mockResolvedValue(disabled);
  const onUpdate = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><CodeReviewExtensions
    api={{ list: vi.fn(), install: vi.fn(), prepare: vi.fn(), change }} projectId="project"
    items={[item]} loading={false} loadError={false} retry={vi.fn()} activities={[]} onUpdate={onUpdate} offline={false}
  /></QueryClientProvider>);

  const row = screen.getByRole("button", { name: item.name });
  row.focus();
  fireEvent.click(row);
  const details = screen.getByRole("dialog", { name: "Package details" });
  expect(within(details).getByText(item.fileName)).toBeVisible();
  fireEvent.click(within(details).getByRole("button", { name: "Close" }));
  expect(row).toHaveFocus();

  const manage = screen.getByRole("button", { name: `Manage ${item.name}` });
  fireEvent.click(manage);
  expect(manage).toHaveAttribute("aria-expanded", "true");
  const disable = screen.getByRole("menuitem", { name: "Disable" });
  expect(disable).toHaveFocus();
  fireEvent.keyDown(disable, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(manage).toHaveFocus();

  fireEvent.click(manage);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Disable" }), { key: "Enter" });
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(item.id, disabled));
  expect(change).toHaveBeenCalledExactlyOnceWith("project", item.id, "disable");
});
