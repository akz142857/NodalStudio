import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { KnowledgeReview } from "./KnowledgeReview";
import { useCallback, useEffect, useState } from "react";
import type {
  DatabaseSnapshot,
  EffectiveSettings,
  ObjectAnnotation,
  RuntimeInfo,
  SaveAnnotationInput,
  SavedView,
  SchemaChangeSet,
  SemanticBundle,
  NodalStudioPlatform,
  TableDefinition,
  TableAiEvidence,
} from "../platform";
import { AiAssistant } from "./AiAssistant";
import { TableAiAssistant } from "./TableAiAssistant";
import { HistoryPanel } from "./HistoryPanel";
import { KnowledgePanel } from "./KnowledgePanel";
import { ProvenancePanel } from "./ProvenancePanel";
import { Segmented } from "./Segmented";
import { TableKnowledgeForm, TableStructure } from "./TableInspector";

type InspectorSegment = "structure" | "semantics" | "history" | "ai";



interface InspectorPanelProps {
  onOpenObject?: (key: import("../platform").ObjectKey) => void;
  explainRequest?: number;
  snapshot?: DatabaseSnapshot;
  selectedTable?: TableDefinition;
  historicalSelection?: boolean;
  changeSet?: SchemaChangeSet;
  semantics: SemanticBundle;
  settings: EffectiveSettings;
  runtime?: RuntimeInfo;
  platform: NodalStudioPlatform;
  historyRevision: string;
  onSaveAnnotation: (input: SaveAnnotationInput) => Promise<void>;
  onRefreshSemantics: () => Promise<void>;
  onSemanticsChange: (semantics: SemanticBundle) => void;
  onApplyView: (view: SavedView | undefined) => void;
  historyPreview?: boolean;
  onOpenQuery?: (table: TableDefinition) => void;
  onOpenSettings: (category: "ai" | "cloud" | "git") => void;
  onSelectSnapshot: (snapshot: DatabaseSnapshot) => void;
  onCompareSnapshots: (snapshot: DatabaseSnapshot, changeSet: SchemaChangeSet) => void;
  onReviewChanges?: () => void;
}

function findAnnotation(
  semantics: SemanticBundle,
  table: TableDefinition | undefined,
): ObjectAnnotation | undefined {
  if (!table) return undefined;
  return semantics.annotations.find(
    (item) =>
      item.objectKey.kind === "table" &&
      item.objectKey.schema === table.key.schema &&
      item.objectKey.name === table.key.name,
  );
}

/**
 * The right-hand inspector, as facets of one thing rather than a stack.
 *
 * Each segment answers a different question about whatever is selected, and
 * falls back to the same question asked of the whole snapshot when nothing is —
 * so the segments never disappear and their positions stay learnable.
 */
export function InspectorPanel({
  onOpenObject,
  explainRequest,
  snapshot,
  selectedTable,
  historicalSelection = false,
  changeSet,
  semantics,
  settings,
  runtime,
  platform,
  historyRevision,
  onSaveAnnotation,
  onSemanticsChange,
  onRefreshSemantics,
  onApplyView,
  historyPreview,
  onOpenQuery,
  onOpenSettings,
  onSelectSnapshot,
  onCompareSnapshots,
  onReviewChanges,
}: InspectorPanelProps) {
  const { t: bt } = useI18n();
  const SEGMENTS = [
  { value: "structure", label: bt("business.table") },
  { value: "semantics", label: bt("business.semantics") },
  { value: "history", label: bt("business.history") },
  { value: "ai", label: "AI" },
] as const satisfies readonly { value: InspectorSegment; label: string }[];
  const [segment, setSegment] = useState<InspectorSegment>("structure");
  const [handledExplainRequest, setHandledExplainRequest] = useState(explainRequest);
  if (explainRequest !== handledExplainRequest) {
    setHandledExplainRequest(explainRequest);
    if (explainRequest) setSegment("ai");
  }
  const [evidenceSelection, setEvidenceSelection] = useState<{ scope: string; requestId: string; evidence: TableAiEvidence }>();
  const [evidenceRequestId, setEvidenceRequestId] = useState<string>();
  const handleAiTaskChange = useCallback((requestId: string | undefined) => {
    setEvidenceRequestId(requestId);
    setEvidenceSelection(undefined);
  }, []);
  const evidenceScope = JSON.stringify([snapshot?.sourceId, snapshot?.id, snapshot?.fingerprint, selectedTable?.key, historicalSelection, settings.source?.sourceId, settings.source?.ai, settings.app.privacy.offlineMode, semantics.domainGroups, semantics.logicalRelationships, semantics.knowledge]);
  const focusedEvidence = evidenceSelection?.scope === evidenceScope && evidenceSelection.requestId === evidenceRequestId ? evidenceSelection.evidence : undefined;
  const evidenceTable = focusedEvidence && snapshot?.schemas.flatMap((schema) => schema.tables).find((table) => table.key.schema === focusedEvidence.tableKey.schema && table.key.name === focusedEvidence.tableKey.name);

  // The Database title opens schema history without changing the selected object.
  useEffect(() => {
    const openHistory = () => setSegment("history");
    window.addEventListener("nodalstudio:inspect-history", openHistory);
    return () => window.removeEventListener("nodalstudio:inspect-history", openHistory);
  }, []);
  const annotation = findAnnotation(semantics, selectedTable);
  const aiEnabled = Boolean(settings.source?.ai.enabled) && !(settings.app.privacy.offlineMode && settings.source?.ai.provider !== "offline");
  const aiProviderLabel =
    settings.source?.ai.provider === "openAiCompatible" ? bt("business.remote") : bt("business.offline");

  if (!snapshot) {
    return (
      <div className="ds-surface inspector-view inspector-empty">
        <h2>{bt("business.inspector")}</h2>
        <p>{bt("business.connectADataSourceToInspectItsModel")}</p>
      </div>
    );
  }

  return (
    <div className="ds-surface inspector-view">
      <header className="inspector-header">
        <span className="inspector-context">{selectedTable ? bt("business.tableDetail", { value0: (segment === "structure" && evidenceTable ? evidenceTable : selectedTable).key.schema }) : bt("business.database")}</span>
        <h2 className="inspector-title">{segment === "structure" && evidenceTable ? `${evidenceTable.key.schema}.${evidenceTable.key.name}` : selectedTable ? selectedTable.key.name : snapshot.database.name}</h2>
        {historicalSelection ? <p className="historical-selection-note">{bt("business.deletedTableBeforeSnapshot")}</p> : null}
        <div className="inspector-segments">
          <Segmented
            label={bt("business.inspectorSection")}
            value={segment}
            options={SEGMENTS}
            onChange={setSegment}
          />
        </div>
      </header>
      <div className="inspector-body">

      {segment === "structure" ? (
        selectedTable ? (
          <>
            {focusedEvidence && evidenceTable ? <section className="ai-evidence-source" aria-label={bt("business.locatedEvidence")}>
              <strong>{focusedEvidence.id} · {focusedEvidence.label}</strong>
              <p>{focusedEvidence.kind} {bt("business.snapshot")} {snapshot.fingerprint.slice(0, 12)}</p>
              <pre>{focusedEvidence.detail}</pre>
              <button type="button" onClick={() => setSegment("ai")}>{bt("business.backToAIExplanation")}</button>
            </section> : null}
            <TableStructure onOpenObject={onOpenObject} snapshot={snapshot} table={evidenceTable || selectedTable} focusedEvidence={focusedEvidence} onOpenQuery={historicalSelection ? undefined : onOpenQuery} />
          </>
        ) : (
          <dl className="snapshot-summary">
            <div>
              <dt>{bt("business.database")}</dt>
              <dd>{snapshot.database.name}</dd>
            </div>
            <div>
              <dt>{bt("business.schemas")}</dt>
              <dd>{snapshot.schemas.length}</dd>
            </div>
            <div>
              <dt>{bt("business.tables")}</dt>
              <dd>
                {snapshot.schemas.reduce((total, schema) => total + schema.tables.length, 0)}
              </dd>
            </div>
          </dl>
        )
      ) : null}

      {segment === "semantics" ? (
        historicalSelection ? <p>{bt("business.thisDeletedTableBelongsToBeforeItsHistoricalStructure")}</p> : <>
          {selectedTable ? (
            <TableKnowledgeForm
              key={`${selectedTable.key.schema}.${selectedTable.key.name}:${annotation?.updatedAt ?? "new"}`}
              table={selectedTable}
              sourceId={snapshot.sourceId}
              annotation={annotation}
              onSaveAnnotation={onSaveAnnotation}
            />
          ) : null}
          <KnowledgeReview platform={platform} snapshot={snapshot} semantics={semantics} table={selectedTable} desktop={runtime?.kind === "desktop"} onRefresh={onRefreshSemantics} />
          <KnowledgePanel
            sourceId={snapshot.sourceId}
            snapshotId={snapshot.id}
            readOnly={historyPreview}
            selectedTable={selectedTable}
            semantics={semantics}
            platform={platform}
            onChange={onSemanticsChange}
            onApplyView={onApplyView}
          />
        </>
      ) : null}

      {segment === "history" ? (
        <>
          {changeSet ? (
            <section className="change-summary">
              <h3>{changeSet.operations.length} {bt("business.structuralChanges")}</h3>
              <div className="risk-grid">
                {(["high", "medium", "low", "informational"] as const).map((risk) => (
                  <div key={risk} data-risk={risk}>
                    <strong>{changeSet.riskSummary[risk]}</strong>
                    <span title={risk === "informational" ? bt("business.informational") : undefined}>{risk === "informational" ? bt("business.info") : translateUiLabel(risk, bt)}</span>
                  </div>
                ))}
              </div>
              <p className="muted-copy">{bt("business.compareBeforeAndAfterInTheChangeList")}</p>
              {onReviewChanges ? <button className="review-changes-button" type="button" onClick={onReviewChanges}>{bt("business.reviewAllChanges")}</button> : null}
            </section>
          ) : null}
          {changeSet && runtime?.kind === "desktop"
            && settings.app.advanced.extensions.migrationProvenance ? (
              <details className="inspector-disclosure"><summary>{bt("business.gitMigrationEvidence")}</summary><ProvenancePanel changeSetId={changeSet.id} platform={platform} /></details>
            ) : null}
          <HistoryPanel
            key={snapshot.sourceId}
            sourceId={snapshot.sourceId}
            activeSnapshot={snapshot}
            revision={historyRevision}
            platform={platform}
            onSelect={onSelectSnapshot}
            onCompare={onCompareSnapshots}
          />
        </>
      ) : null}

      {selectedTable && !historicalSelection ? <div hidden={segment !== "ai"}>
        <TableAiAssistant
          key={evidenceScope}
          platform={platform} snapshot={snapshot} table={selectedTable} settings={settings} active={segment === "ai"}
          onKnowledgeSaved={onRefreshSemantics}
          domains={semantics.domainGroups} desktop={runtime?.kind === "desktop"}
          onOpenSettings={() => onOpenSettings("ai")}
          onTaskChange={handleAiTaskChange}
          onLocateEvidence={(evidence, requestId) => {
            if (requestId !== evidenceRequestId) return;
            setEvidenceSelection({ scope: evidenceScope, requestId, evidence }); setSegment("structure");
          }}
        />
      </div> : null}
      {segment === "ai" && (!selectedTable || historicalSelection) ? (
        historicalSelection ? <p>{bt("business.reviewThisDeletedTableSBeforePropertiesInThe")}</p> : changeSet ? (
          <AiAssistant
            platform={platform}
            input={{ snapshotId: snapshot.id, targetType: "changeSet", changeSet }}
            enabled={aiEnabled}
            providerLabel={aiProviderLabel}
            onOpenSettings={() => onOpenSettings("ai")}
          />
        ) : (
          <p>{bt("business.selectATableToExplainOrCompareTwoSnapshots")}</p>
        )
      ) : null}
      </div>
    </div>
  );
}
