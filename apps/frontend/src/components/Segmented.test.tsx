import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";

describe("Segmented", () => {
  const options = [
    { value: "explore", label: "Database" },
    { value: "query", label: "Query", disabled: true, title: "Query requires the desktop app" },
    { value: "history", label: "History" },
  ] as const;

  it("marks the active segment and reports the one that was chosen", () => {
    const onChange = vi.fn();
    render(
      <Segmented label="View mode" value="explore" options={options} onChange={onChange} />,
    );

    // The pressed state is what assistive technology reads, so it has to track
    // `value` rather than only the class the fill is drawn from.
    expect(screen.getByRole("button", { name: "Database" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Database" })).toHaveClass("active");

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(onChange).toHaveBeenCalledWith("history");
  });

  it("keeps a disabled segment inert and explains why", () => {
    const onChange = vi.fn();
    render(
      <Segmented label="View mode" value="explore" options={options} onChange={onChange} />,
    );

    const query = screen.getByRole("button", { name: "Query" });
    expect(query).toBeDisabled();
    expect(query).toHaveAttribute("title", "Query requires the desktop app");

    fireEvent.click(query);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("names the group so the segments are not four loose buttons", () => {
    render(
      <Segmented label="View mode" value="explore" options={options} onChange={vi.fn()} />,
    );

    expect(screen.getByRole("group", { name: "View mode" })).toBeVisible();
  });
});
