import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectEdge, ProjectNode, NodalStudioPlatform } from "../platform";
import { SystemMap } from "./SystemMap";

vi.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({ edges }: { edges: ProjectEdge[] }) => <div data-testid="flow-edges">{edges.map((edge) => edge.id).join(",")}</div>,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
  useNodesState: <T,>(initial: T[]) => {
    const [values, setValues] = useState(initial);
    return [values, setValues, vi.fn()] as const;
  },
  useEdgesState: <T,>(initial: T[]) => {
    const [values, setValues] = useState(initial);
    return [values, setValues, vi.fn()] as const;
  },
}));

vi.mock("./AiReviewQueue", () => ({ AiReviewQueue: () => null }));

const node = (id: string): ProjectNode => ({
  id,
  projectId: "project",
  kind: id === "table" ? "table" : "service",
  name: id,
  qualifiedName: id,
  relativePath: null,
  line: null,
  databaseObject: id === "table" ? { kind: "table", schema: "public", name: "orders" } : null,
  attributes: {},
});

const edge = (id: string, certainty: ProjectEdge["certainty"]): ProjectEdge => ({
  id,
  sourceId: "service",
  targetId: "table",
  kind: "reads",
  certainty,
  reviewStatus: certainty === "aiInferred" ? "pending" : "notRequired",
  evidence: [],
  scanId: "scan",
});

describe("SystemMap", () => {
  it("updates visible edges when evidence filtering keeps the same nodes", async () => {
    const platform = {
      listLocalProjects: vi.fn().mockResolvedValue([{ id: "project", name: "API", rootPath: "", repositoryKind: "directory", remoteUrl: null, managedCache: false, databaseSourceIds: ["source"], createdAt: "2026-01-01T00:00:00Z" }]),
      listProjectScans: vi.fn().mockResolvedValue([{ id: "scan", projectId: "project", branch: null, commitSha: null, dirty: false, status: "ready", analyzerVersions: {}, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z" }]),
      getProjectGraph: vi.fn().mockResolvedValue({ scanId: "scan", nodes: [node("service"), node("table")], edges: [edge("static", "static"), edge("inferred", "aiInferred")] }),
      listAiCandidates: vi.fn().mockResolvedValue([]),
    } as unknown as NodalStudioPlatform;
    render(<SystemMap platform={platform} sourceId="source" query="" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("flow-edges")).toHaveTextContent("static,inferred"));

    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "confirmed" } });
    await waitFor(() => expect(screen.getByTestId("flow-edges")).toHaveTextContent("static"));
    expect(screen.getByTestId("flow-edges")).not.toHaveTextContent("inferred");
  });
});
