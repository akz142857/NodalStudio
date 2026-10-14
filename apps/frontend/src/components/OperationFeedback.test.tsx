import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperationFeedback } from "./OperationFeedback";
describe("OperationFeedback", () => {
  it("announces running state without retry or dismiss actions", () => {
    render(<OperationFeedback label="Report export" state={{ phase: "running", summary: "Writing report…" }} onRetry={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Report export" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Running · Writing report…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("displays an error with escaped details and explicit retry/dismiss actions", () => {
    const retry = vi.fn(); const dismiss = vi.fn();
    const { container, rerender } = render(<OperationFeedback label="Layout" state={{ phase: "error", summary: "Save failed.", details: '<script>alert("secret")</script>\nDisk unavailable' }} onRetry={retry} retryLabel="Retry layout save" onDismiss={dismiss} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Disk unavailable");
    expect(container.querySelector("script")).toBeNull(); expect(screen.getByText("Error details").closest("details")).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Retry layout save" })); expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss result" })); expect(dismiss).toHaveBeenCalledOnce();
    rerender(<OperationFeedback label="Layout" state={{ phase: "error", summary: "Save failed." }} onRetry={retry} retryDisabled />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
  it("shows completion summaries, optional details and informational capability limits without retry", () => {
    const { rerender } = render(<OperationFeedback label="Check" state={{ phase: "success", summary: "500 tables checked", details: "Partial rule coverage" }} onRetry={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Completed · 500 tables checked");
    expect(screen.getByText("Result details").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<OperationFeedback label="Check" state={{ phase: "info", summary: "History not included in this share." }} onRetry={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Information"); expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<OperationFeedback label="Check" />); expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
