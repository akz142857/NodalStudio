import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodeUsageResult, NodalStudioPlatform } from "../platform";
import { CodeUsagePanel } from "./CodeUsagePanel";

describe("CodeUsagePanel", () => {
  it("shows confirmed query evidence for a database table", async () => {
    const usage: CodeUsageResult = {
      nodes: [
        {
          id: "query",
          projectId: "project",
          kind: "query",
          name: "Query 1",
          qualifiedName: "queries/orders.sql#1",
          relativePath: "queries/orders.sql",
          line: 2,
          databaseObject: null,
          attributes: { operation: "select" },
        },
      ],
      edges: [
        {
          id: "edge",
          sourceId: "query",
          targetId: "table",
          kind: "reads",
          certainty: "declared",
          reviewStatus: "notRequired",
          scanId: "scan",
          evidence: [
            {
              id: "evidence",
              projectId: "project",
              relativePath: "queries/orders.sql",
              startLine: 2,
              endLine: 2,
              symbol: null,
              analyzer: "generic-sql-v1",
              excerptHash: "hash",
              explanation: "SELECT reads this table",
            },
          ],
        },
      ],
    };
    const getDatabaseCodeUsage = vi.fn().mockResolvedValue(usage);
    const platform = { getDatabaseCodeUsage } as unknown as NodalStudioPlatform;

    render(
      <CodeUsagePanel
        platform={platform}
        sourceId="source"
        objectKey={{ kind: "table", schema: "public", name: "orders" }}
      />,
    );

    expect(await screen.findByText("queries/orders.sql#1")).toBeInTheDocument();
    expect(screen.getByText("queries/orders.sql:2")).toBeInTheDocument();
    expect(screen.getByText("SELECT reads this table · generic-sql-v1")).toBeInTheDocument();
    expect(getDatabaseCodeUsage).toHaveBeenCalledWith("source", {
      kind: "table",
      schema: "public",
      name: "orders",
    });
  });
});
