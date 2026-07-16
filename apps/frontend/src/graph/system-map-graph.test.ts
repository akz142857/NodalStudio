import { describe, expect, it } from "vitest";
import type { ProjectGraphSnapshot, ProjectNode } from "../platform";
import { buildSystemFlow, filterSystemGraph } from "./system-map-graph";

const node = (id: string, kind: ProjectNode["kind"], projectId = "project"): ProjectNode => ({
  id,
  projectId,
  kind,
  name: id,
  qualifiedName: id,
  relativePath: null,
  line: null,
  databaseObject: null,
  attributes: {},
});

const graph: ProjectGraphSnapshot = {
  scanId: "scan",
  nodes: [node("file", "file"), node("api", "endpoint"), node("service", "service"), node("query", "query"), node("table", "table")],
  edges: [
    { id: "static", sourceId: "api", targetId: "service", kind: "handles", certainty: "static", reviewStatus: "notRequired", evidence: [], scanId: "scan" },
    { id: "inferred", sourceId: "service", targetId: "query", kind: "calls", certainty: "convention", reviewStatus: "notRequired", evidence: [], scanId: "scan" },
    { id: "read", sourceId: "query", targetId: "table", kind: "reads", certainty: "declared", reviewStatus: "notRequired", evidence: [], scanId: "scan" },
  ],
};

describe("system map graph", () => {
  it("removes file noise and filters inferred edges", () => {
    const filtered = filterSystemGraph(graph, "", "all", "confirmed");
    expect(filtered.nodes.some((candidate) => candidate.kind === "file")).toBe(false);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["static", "read"]);
  });

  it("lays architecture stages into left-to-right lanes", () => {
    const flow = buildSystemFlow(filterSystemGraph(graph, "", "all", "all"));
    const positions = Object.fromEntries(flow.nodes.map((candidate) => [candidate.id, candidate.position.x]));
    expect(positions.api).toBeLessThan(positions.service);
    expect(positions.service).toBeLessThan(positions.query);
    expect(positions.query).toBeLessThan(positions.table);
    expect(flow.edges.find((edge) => edge.id === "inferred")?.style?.strokeDasharray).toBe("7 5");
  });
});
