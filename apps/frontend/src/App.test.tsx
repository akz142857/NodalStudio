import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the product foundation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Nodal Studio" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Your database model, kept visible." }),
    ).toBeVisible();
    expect(await screen.findByText("Web runtime")).toBeVisible();
  });

  it("says so when stored settings cannot be loaded instead of quietly using defaults", async () => {
    // Defaults carry the privacy and cloud posture, so substituting them in
    // silence makes a load failure look like a fresh install.
    vi.spyOn(getPlatform(), "getSettings").mockRejectedValue(new Error("keychain unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open notifications" }));
    expect(await screen.findByText("Stored settings could not be loaded")).toBeVisible();
    expect(screen.getByText(/keychain unavailable/)).toBeVisible();
    expect(screen.getByText(/default privacy and cloud options/)).toBeVisible();
  });
});
