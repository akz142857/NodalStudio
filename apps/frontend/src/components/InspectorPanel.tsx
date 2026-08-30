import { useState } from "react";
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
} from "../platform";
import { AiAssistant } from "./AiAssistant";
import { HistoryPanel } from "./HistoryPanel";
import { KnowledgePanel } from "./KnowledgePanel";
import { ProvenancePanel } from "./ProvenancePanel";
import { Segmented } from "./Segmented";
import { TableKnowledgeForm, TableStructure } from "./TableInspector";

type InspectorSegment = "structure" | "semantics" | "history" | "ai";

const SEGMENTS = [
  { value: "structure", label: "Table" },
  { value: "semantics", label: "Semantics" },
  { value: "history", label: "History" },
  { value: "ai", label: "AI" },
] as const satisfies readonly { value: InspectorSegment; label: string }[];

interface InspectorPanelProps {
  snapshot?: DatabaseSnapshot;
  selectedTable?: TableDefinition;
  changeSet?: SchemaChangeSet;
  semantics: SemanticBundle;
  settings: EffectiveSettings;
  runtime?: RuntimeInfo;
  platform: NodalStudioPlatform;
  historyRevision: string;
  onSaveAnnotation: (input: SaveAnnotationInput) => Promise<void>;
  onSemanticsChange: (semantics: SemanticBundle) => void;
  onApplyView: (view: SavedView | undefined) => void;
  onOpenQuery?: (table: TableDefinition) => void;
  onOpenSettings: (category: "ai" | "cloud" | "git") => void;
  onSelectSnapshot: (snapshot: DatabaseSnapshot) => void;
  onCompareSnapshots: (snapshot: DatabaseSnapshot, changeSet: SchemaChangeSet) => void;
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
  snapshot,
  selectedTable,
  changeSet,
  semantics,
  settings,
  runtime,
  platform,
  historyRevision,
  onSaveAnnotation,
  onSemanticsChange,
  onApplyView,
  onOpenQuery,
  onOpenSettings,
  onSelectSnapshot,
  onCompareSnapshots,
}: InspectorPanelProps) {
  const [segment, setSegment] = useState<InspectorSegment>("structure");
  const annotation = findAnnotation(semantics, selectedTable);
  const aiEnabled = Boolean(settings.source?.ai.enabled) && !settings.app.privacy.offlineMode;
  const aiProviderLabel =
    settings.source?.ai.provider === "openAiCompatible" ? "Remote" : "Offline";

  if (!snapshot) {
    return (
      <>
        <h2>Inspector</h2>
        <p>Connect a data source to inspect its model.</p>
      </>
    );
  }

  return (
    <>
      <h2>{selectedTable ? selectedTable.key.name : snapshot.database.name}</h2>
      <Segmented
        className="inspector-segments"
        label="Inspector section"
        value={segment}
        options={SEGMENTS}
        onChange={setSegment}
      />

      {segment === "structure" ? (
        selectedTable ? (
          <TableStructure table={selectedTable} onOpenQuery={onOpenQuery} />
        ) : (
          <dl className="snapshot-summary">
            <div>
              <dt>Database</dt>
              <dd>{snapshot.database.name}</dd>
            </div>
            <div>
              <dt>Schemas</dt>
              <dd>{snapshot.schemas.length}</dd>
            </div>
            <div>
              <dt>Tables</dt>
              <dd>
                {snapshot.schemas.reduce((total, schema) => total + schema.tables.length, 0)}
              </dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd title={snapshot.fingerprint}>{snapshot.fingerprint.slice(0, 12)}</dd>
            </div>
          </dl>
        )
      ) : null}

      {segment === "semantics" ? (
        <>
          {selectedTable ? (
            <TableKnowledgeForm
              key={`${selectedTable.key.schema}.${selectedTable.key.name}:${annotation?.updatedAt ?? "new"}`}
              table={selectedTable}
              sourceId={snapshot.sourceId}
              annotation={annotation}
              onSaveAnnotation={onSaveAnnotation}
            />
          ) : null}
          <KnowledgePanel
            sourceId={snapshot.sourceId}
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
              <h3>{changeSet.operations.length} structural changes</h3>
              <div className="risk-grid">
                {(["high", "medium", "low", "informational"] as const).map((risk) => (
                  <div key={risk} data-risk={risk}>
                    <strong>{changeSet.riskSummary[risk]}</strong>
                    <span>{risk}</span>
                  </div>
                ))}
              </div>
              <ol className="operation-list">
                {changeSet.operations.slice(0, 30).map((operation, index) => (
                  <li key={`${operation.object.schema}.${operation.object.name}.${index}`}>
                    <span data-risk={operation.risk}>{operation.operationType}</span>
                    <strong>{operation.object.name}</strong>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {changeSet && runtime?.kind === "desktop"
            && settings.app.advanced.extensions.migrationProvenance ? (
              <ProvenancePanel changeSetId={changeSet.id} platform={platform} />
            ) : null}
          <HistoryPanel
            sourceId={snapshot.sourceId}
            revision={historyRevision}
            platform={platform}
            onSelect={onSelectSnapshot}
            onCompare={onCompareSnapshots}
          />
        </>
      ) : null}

      {segment === "ai" ? (
        selectedTable ? (
          <AiAssistant
            platform={platform}
            enabled={aiEnabled}
            providerLabel={aiProviderLabel}
            onOpenSettings={() => onOpenSettings("ai")}
            input={{
              snapshotId: snapshot.id,
              targetType: "table",
              objectKey: selectedTable.key,
            }}
            onConfirmCandidate={(candidate) =>
              onSaveAnnotation({
                sourceId: snapshot.sourceId,
                objectKey: selectedTable.key,
                description: candidate,
                tags: annotation?.tags ?? [],
                owner: annotation?.owner ?? null,
                isCore: annotation?.isCore ?? false,
              })
            }
          />
        ) : changeSet ? (
          <AiAssistant
            platform={platform}
            input={{ snapshotId: snapshot.id, targetType: "changeSet", changeSet }}
            enabled={aiEnabled}
            providerLabel={aiProviderLabel}
            onOpenSettings={() => onOpenSettings("ai")}
          />
        ) : (
          <p>Select a table to explain, or compare two snapshots to explain a change set.</p>
        )
      ) : null}
    </>
  );
}
