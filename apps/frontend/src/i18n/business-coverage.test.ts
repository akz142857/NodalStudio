import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { createTranslator } from "./messages";
import { translateUiLabel } from "./business-labels";
import { relationshipStatusLabels, relationshipCardinalityLabel } from "../components/relationships/relationship-labels";
import { tableArrangementLabels } from "../graph/arrange-tables";
import { PROPERTY_LABELS } from "../components/schema-change-details";

it("covers application-owned relationship, layout and snapshot property metadata", () => {
  const t = createTranslator("zh-CN");
  const labels = [...Object.values(relationshipStatusLabels), ...Object.values(tableArrangementLabels), ...Object.values(PROPERTY_LABELS), ...["oneToOne", "oneToMany", "manyToOne", "manyToMany", "unspecified"].map(relationshipCardinalityLabel)];
  for (const label of labels) expect(translateUiLabel(label, t), label).not.toBe(label);
  expect(translateUiLabel("customer_supplied_identifier", t)).toBe("customer_supplied_identifier");
});

it("keeps static business-page copy in the shared catalog", () => {
  const files = [
  "components/ConnectionPanel.tsx",
  "components/ConnectionManager.tsx",
  "components/ConnectionSecurityFields.tsx",
  "components/ConnectionTestStatus.tsx",
  "components/DataSourcePicker.tsx",
  "components/DdlImportPanel.tsx",
  "components/SchemaTree.tsx",
  "components/SchemaEnumDetails.tsx",
  "components/SchemaObjectMenu.tsx",
  "components/InspectorPanel.tsx",
  "components/TableInspector.tsx",
  "components/DatabaseSnapshotHeader.tsx",
  "components/TableNode.tsx",
  "components/CanvasToolbar.tsx",
  "components/SchemaCanvas.tsx",
  "components/DiagramToolbarMenu.tsx",
  "components/DiagramSelectionActions.tsx",
  "components/DiagramLayoutActions.tsx",
  "components/DiagramMiniMap.tsx",
  "components/SavedViewsToolbar.tsx",
  "components/DiagramExportActions.tsx",
  "components/HistoryPanel.tsx",
  "components/SchemaChangesPanel.tsx",
  "components/SchemaChangesDiagram.tsx",
  "components/ChangesEmptyState.tsx",
  "components/SchemaPreflightPanel.tsx",
  "components/SchemaReportExportAction.tsx",
  "components/OperationFeedback.tsx",
  "components/BusinessExplorer.tsx",
  "components/relationships/ComparisonEdge.tsx",
  "components/relationships/EdgePaintCommitBoundary.tsx",
  "components/relationships/InferredRelationshipReview.tsx",
  "components/relationships/RelationshipBatchPanel.tsx",
  "components/relationships/RelationshipCreatePopover.tsx",
  "components/relationships/RelationshipDeleteDialog.tsx",
  "components/relationships/RelationshipEditor.tsx",
  "components/relationships/RelationshipInspector.tsx",
  "components/relationships/RelationshipManager.tsx",
  "components/relationships/RelationshipPresentation.tsx",
  "components/relationships/RelationshipTargetPicker.tsx",
  "components/relationships/SharedEdgeLayer.tsx",
  "components/query/ColumnProfileDetails.tsx",
  "components/query/QueryDraftAnswer.tsx",
  "components/query/QueryDraftPanel.tsx",
  "components/query/QueryHistory.tsx",
  "components/query/QueryPage.tsx",
  "components/query/QueryResultArtifact.tsx",
  "components/query/QueryResultGrid.tsx",
  "components/query/QueryRunControls.tsx",
  "components/query/ResultExportDialog.tsx",
  "components/query/SqlEditor.tsx",
  "components/KnowledgePanel.tsx",
  "components/DiscoveryAssistant.tsx",
  "components/AiAssistant.tsx",
  "components/KnowledgeReview.tsx",
  "components/ProvenancePanel.tsx"
];
  const identifiers = new Set(["Nodal Studio", "PostgreSQL", "MySQL", "NULL", "UQ", "IX", "?FK", "LR", "GEN", "DEP", "bastion.example.com", "001.sql, 002.sql"]);
  const remaining: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(`src/${file}`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      let text: string | undefined;
      if (ts.isJsxText(node)) text = node.text.trim();
      if (ts.isJsxAttribute(node) && ["label", "title", "description", "aria-label", "placeholder", "retryLabel"].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) text = node.initializer.text;
      if (text && /[a-z\u4e00-\u9fff]/i.test(text) && !identifiers.has(text)) remaining.push(`${file}: ${text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(remaining).toEqual([]);
});
