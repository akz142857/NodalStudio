import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultDataSourceSettings, type NodalStudioPlatform } from "../platform";
import { CloudSyncPanel } from "./CloudSyncPanel";

describe("CloudSyncPanel", () => {
  it("publishes only when Cloud is explicitly configured in Settings", async () => {
    const syncProject = vi.fn().mockResolvedValue({
      version: 1,
      fingerprint: "abc",
      deduplicated: false,
      uploadedEvents: 2,
    });
    const platform = { syncProject } as unknown as NodalStudioPlatform;
    const settings = defaultDataSourceSettings("source").cloud;
    settings.enabled = true;
    settings.endpoint = "https://schema.example/";
    settings.projectId = "a0c11f98-a0af-40f1-8313-f9a4ea068412";
    render(<CloudSyncPanel sourceId="source" platform={platform} settings={settings} offline={false} onOpenSettings={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Cloud access token"), {
      target: { value: "temporary-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish metadata" }));

    await waitFor(() => expect(syncProject).toHaveBeenCalledTimes(1));
    expect(syncProject).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source",
        apiUrl: "https://schema.example/",
        projectId: "a0c11f98-a0af-40f1-8313-f9a4ea068412",
        accessToken: "temporary-token",
        baseVersion: 0,
      }),
    );
    expect(await screen.findByText("Synced · version 1")).toBeVisible();
  });
});
