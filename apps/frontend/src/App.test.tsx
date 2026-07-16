import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
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
});

