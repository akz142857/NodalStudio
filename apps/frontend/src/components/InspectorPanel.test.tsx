import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseSnapshot,
  SemanticBundle,
  NodalStudioPlatform,
  TableDefinition,
} from "../platform";
import { defaultEffectiveSettings } from "../platform";
import { InspectorPanel } from "./InspectorPanel";

const table = {
  key: { kind: "table", schema: "public", name: "orders" },
  tableKind: "ordinary",
  columns: [],
  primaryKey: null,
  foreignKeys: [],
  indexes: [],
  constraints: [],
  comment: null,
} as unknown as TableDefinition;

const snapshot = {
  id: "snapshot",
  sourceId: "source",
  fingerprint: "abcdef123456",
  database: { name: "flow", databaseType: "postgres" },
  schemas: [{ name: "public", tables: [table], views: [], enums: [] }],
} as unknown as DatabaseSnapshot;

const semantics = {
  annotations: [],
  orphanedAnnotations: [],
  domainGroups: [],
  savedViews: [],
  logicalRelationships: [],
  ignoredRelationshipInferences: [],
} as unknown as SemanticBundle;

function renderPanel(overrides: Partial<Parameters<typeof InspectorPanel>[0]> = {}) {
  const platform = {
    listSnapshots: vi.fn().mockResolvedValue([]),
  } as unknown as NodalStudioPlatform;
  return render(
    <InspectorPanel
      snapshot={snapshot}
      semantics={semantics}
      settings={defaultEffectiveSettings()}
      platform={platform}
      historyRevision="snapshot"
      onSaveAnnotation={vi.fn().mockResolvedValue(undefined)}
      onSemanticsChange={vi.fn()}
      onApplyView={vi.fn()}
      onOpenSettings={vi.fn()}
      onSelectSnapshot={vi.fn()}
      onCompareSnapshots={vi.fn()}
      {...overrides}
    />,
  );
}

describe("InspectorPanel", () => {
  it("keeps every segment present with nothing selected", () => {
    // Segments that come and go with the selection would move under the cursor,
    // so each one answers its question about the snapshot instead.
    renderPanel();

    for (const name of ["Table", "Semantics", "History", "AI"]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
    expect(screen.getByText("Fingerprint")).toBeVisible();
    expect(screen.getByRole("heading", { name: "flow" })).toBeVisible();
  });

  it("shows the table's structure and its knowledge form on separate segments", () => {
    renderPanel({ selectedTable: table });

    expect(screen.getByRole("heading", { name: "orders" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Columns" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Team knowledge" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Semantics" }));
    expect(screen.getByRole("heading", { name: "Team knowledge" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Columns" })).not.toBeInTheDocument();
  });

  it("explains what the AI segment needs rather than going blank", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    expect(screen.getByText(/Select a table to explain/)).toBeVisible();
  });

  it("opens the History segment when the sidebar asks for a comparison", () => {
    renderPanel();
    expect(screen.queryByRole("heading", { name: /Snapshots|History/ })).not.toBeInTheDocument();

    fireEvent(window, new Event("nodalstudio:inspect-history"));
    // The History segment becomes the pressed one; the sidebar's "Compare…" has
    // no panel of its own to fall back on.
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
