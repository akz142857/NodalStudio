import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform } from "../platform";
import { ProvenancePanel } from "./ProvenancePanel";

describe("ProvenancePanel", () => {
  it("associates normalized Git and migration evidence with a change set", async () => {
    const saveChangeProvenance = vi.fn().mockResolvedValue({});
    const platform = { saveChangeProvenance } as unknown as NodalStudioPlatform;
    render(<ProvenancePanel changeSetId="change" platform={platform} />);

    fireEvent.change(screen.getByLabelText("Git branch"), { target: { value: "feature/orders" } });
    fireEvent.change(screen.getByLabelText("Commit SHA"), { target: { value: "ABC123" } });
    fireEvent.change(screen.getByLabelText("Migration files"), { target: { value: "002.sql, 001.sql" } });
    fireEvent.click(screen.getByRole("button", { name: "Save evidence" }));

    await waitFor(() => expect(saveChangeProvenance).toHaveBeenCalledTimes(1));
    expect(saveChangeProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        changeSetId: "change",
        branch: "feature/orders",
        migrationFiles: ["002.sql", "001.sql"],
      }),
    );
  });
});
