import { SchemaIndexDetails } from "./SchemaIndexDetails";
import { TableCatalogDetails } from "./SchemaProgramDetails";
import type { DatabaseSnapshot } from "../platform/types";
import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { useUpdateBlocker } from "../platform/update-guard";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ObjectAnnotation, SaveAnnotationInput, TableAiEvidence, TableDefinition } from "../platform";

interface TableStructureProps {
  columnFocus?: { name: string };
  onOpenObject?: (key: import("../platform").ObjectKey) => void;
  table: TableDefinition;
  snapshot?: DatabaseSnapshot;
  onOpenQuery?: (table: TableDefinition) => void;
  onShowColumnSource?: (name: string) => void;
  focusedEvidence?: TableAiEvidence;
}

interface TableKnowledgeFormProps {
  table: TableDefinition;
  sourceId: string;
  annotation?: ObjectAnnotation;
  readOnly?: boolean;
  onSaveAnnotation: (input: SaveAnnotationInput) => Promise<void>;
}

/**
 * What the database says about a table: shape, keys, indexes, constraints.
 *
 * Split from the knowledge form because the inspector shows one or the other —
 * structure is read-only and comes from the snapshot, the form is authored.
 */
export function TableStructure({ table, snapshot, onOpenQuery, columnFocus, focusedEvidence, onOpenObject, onShowColumnSource }: TableStructureProps) {
  const { t: bt } = useI18n();
  const structure = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!columnFocus) return;
    const target = structure.current?.querySelector<HTMLElement>('[data-column-focus="true"]');
    if (!target) return;
    // Keep the field clear of the inspector's sticky title and segment tabs.
    const header = structure.current?.closest(".inspector-view")?.querySelector<HTMLElement>(".inspector-header");
    target.style.scrollMarginTop = `${(header?.offsetHeight ?? 0) + 8}px`;
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [columnFocus, table]);
  useEffect(() => {
    const target = structure.current?.querySelector<HTMLElement>('[data-evidence-target="true"]')
      ?? structure.current?.querySelector<HTMLElement>('[data-evidence-focus="true"]');
    target?.scrollIntoView?.({ block: "nearest" });
    target?.focus({ preventScroll: true });
  }, [focusedEvidence]);
  const focused = (kind: string, name: string) => focusedEvidence?.objectKey.kind === kind && focusedEvidence.objectKey.name === name;
  // A logical relationship uses a table key, but its source mapping is the
  // navigation target. Preserve mapping order when there are multiple fields.
  const logicalField = focusedEvidence?.kind === "logicalRelationship" ? focusedEvidence.columns[0] : undefined;
  const primaryColumns = new Set(table.primaryKey?.columns ?? []);
  const foreignColumns = new Set(table.foreignKeys.flatMap((key) => key.columns));
  const tableEvidence = focusedEvidence?.kind !== "logicalRelationship" && focused("table", table.key.name);
  const sqliteOptions = [table.sqlite?.strict ? "STRICT" : null, table.sqlite?.withoutRowid ? "WITHOUT ROWID" : null, table.sqlite?.virtualTable ? "VIRTUAL TABLE" : null].filter(Boolean).join(" · ");

  return (
    <div ref={structure} className="table-structure">
      {table.comment || tableEvidence ? <p className="inspector-comment" tabIndex={-1} data-evidence-target={tableEvidence ? "true" : undefined}>{table.comment || `${table.key.schema}.${table.key.name}`}</p> : null}
      {table.tableKind !== "ordinary" && <p className="muted-copy">{bt("business.kind")} · {translateUiLabel(table.tableKind, bt)}</p>}

      <section className="inspector-section table-structure-columns">
        <div className="table-structure-columns-heading">
          <h3>{bt("business.columnsDetail")}</h3>
          {onOpenQuery ? <button type="button" className="inspector-query-button" onClick={() => onOpenQuery(table)}>{bt("business.previewRowsInQuery")}</button> : null}
        </div>
        <div className="inspector-columns">
          {table.columns.map((column) => {
            const sqliteColumn = table.sqlite?.columns?.[column.name];
            return (
              <div key={column.name} tabIndex={-1} data-column-focus={columnFocus?.name === column.name ? "true" : undefined} data-evidence-target={focused("column", column.name) || logicalField === column.name ? "true" : undefined} data-evidence-focus={focused("column", column.name) || focusedEvidence?.columns.includes(column.name) ? "true" : undefined}>
                <span>
                  {primaryColumns.has(column.name) ? <b>{bt("business.pKDetail")}</b> : null}
                  {foreignColumns.has(column.name) ? <b>{bt("business.fK")}</b> : null}
                  <strong>{column.name}</strong>
                </span>
                <small>
                  {column.formattedType}
                  {column.nullable ? "" : bt("business.notNullDetail")}
                </small>
                {sqliteColumn && sqliteColumn.affinity !== column.formattedType.trim().toUpperCase() ? <small>{bt("sqlite.affinity")} · {sqliteColumn.affinity}</small> : null}
                {sqliteColumn?.generationExpression ? <small>{sqliteColumn.generationMode ?? "VIRTUAL"} · {sqliteColumn.generationExpression}</small> : null}
                {column.comment ? <p>{column.comment}</p> : null}
                {onShowColumnSource ? <>
                  {column.identity ? <small>{bt("businessMeta.identity")}: {column.identity}</small> : null}
                  {column.defaultValue !== null ? <small>{bt("businessMeta.default")}: {column.defaultValue}</small> : null}
                  <button type="button" onClick={() => onShowColumnSource(column.name)}>{bt("business.showColumnSource")} · {column.name}</button>
                </> : null}
              </div>
            );
          })}
        </div>
      </section>

      {table.foreignKeys.length > 0 ? (
        <section className="inspector-section">
          <h3>{bt("business.relationships")}</h3>
          <ul className="inspector-list">
            {table.foreignKeys.map((key) => (
              <li key={key.name} tabIndex={-1} data-evidence-target={focused("foreignKey", key.name) ? "true" : undefined} data-evidence-focus={focused("foreignKey", key.name) ? "true" : undefined}>
                <strong>{key.name}</strong>
                <span>
                  {key.columns.join(", ")} → {key.referencedSchema}.{key.referencedTable}(
                  {key.referencedColumns.join(", ")})
                </span>
                {onShowColumnSource ? <span>{bt("business.onDelete")}: {key.onDelete} · {bt("business.onUpdate")}: {key.onUpdate}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <SchemaIndexDetails indexes={table.indexes} focusedName={focusedEvidence?.objectKey.kind === "index" ? focusedEvidence.objectKey.name : undefined} />

      {table.constraints.length > 0 ? (
        <section className="inspector-section">
          <h3>{bt("business.constraints")}</h3>
          <ul className="inspector-list">
            {table.constraints.map((constraint) => (
              <li key={constraint.name} tabIndex={-1} data-evidence-target={focused("constraint", constraint.name) ? "true" : undefined} data-evidence-focus={focused("constraint", constraint.name) ? "true" : undefined}>
                <strong>{constraint.name}</strong>
                <small>{translateUiLabel(constraint.constraintType, bt)}</small><pre tabIndex={0}>{constraint.definition}</pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {snapshot ? <TableCatalogDetails snapshot={snapshot} table={table} onOpenObject={onOpenObject} /> : null}
      {table.sqlite ? <details className="inspector-section table-structure-sqlite"><summary>{bt("sqlite.definition")}</summary>
        {sqliteOptions ? <p>{sqliteOptions}</p> : null}
        {table.sqlite.diagnostics.map((message) => <p key={message} role="note">{message}</p>)}
        <pre tabIndex={0}>{table.sqlite.definition}</pre>
      </details> : null}
    </div>
  );
}

/** What the team says about a table. The physical model stays read-only. */
export function TableKnowledgeForm({
  table,
  sourceId,
  annotation,
  readOnly = false,
  onSaveAnnotation,
}: TableKnowledgeFormProps) {
  const { t: bt } = useI18n();
  const [description, setDescription] = useState(annotation?.description ?? "");
  const [tags, setTags] = useState(annotation?.tags.join(", ") ?? "");
  const [owner, setOwner] = useState(annotation?.owner ?? "");
  const [isCore, setIsCore] = useState(annotation?.isCore ?? false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string>();

  const normalizedTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  useUpdateBlocker(bt("business.saveOrDiscardTableKnowledgeEdits"), !readOnly && (status === "saving" || description !== (annotation?.description ?? "") || JSON.stringify(normalizedTags) !== JSON.stringify(annotation?.tags ?? []) || owner !== (annotation?.owner ?? "") || isCore !== (annotation?.isCore ?? false)));

  async function saveAnnotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || status === "saving") return;
    setError(undefined);
    setStatus("saving");
    try {
      await onSaveAnnotation({
        sourceId,
        objectKey: table.key,
        description: description || null,
        tags: normalizedTags,
        owner: owner || null,
        isCore,
      });
      setStatus("saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  }

  return (
    <form className="annotation-form" onSubmit={(event) => void saveAnnotation(event)}>
      <div className="annotation-heading">
        <h3>{bt("business.teamKnowledge")}</h3>
        <span data-status={status} role={status === "error" ? "alert" : "status"}>
          {readOnly ? bt("business.readOnly") : status === "saving"
            ? bt("business.saving")
            : status === "saved"
              ? bt("business.saved")
              : status === "error"
                ? (error ?? bt("business.saveFailed"))
                : ""}
        </span>
      </div>
      <label>
        {bt("business.description")}<textarea
          rows={3}
          readOnly={readOnly}
          disabled={status === "saving"}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={bt("business.whatBusinessRoleDoesThisTablePlay")}
        />
      </label>
      <label>
        {bt("business.tags")}<input
          readOnly={readOnly}
          disabled={status === "saving"}
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={bt("business.identityBillingCore")}
        />
      </label>
      <label>
        {bt("business.owner")}<input
          readOnly={readOnly}
          disabled={status === "saving"}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder={bt("business.teamOrPerson")}
        />
      </label>
      <label className="core-toggle">
        <input
          type="checkbox"
          disabled={readOnly || status === "saving"}
          checked={isCore}
          onChange={(event) => setIsCore(event.target.checked)}
        />
        {bt("business.markAsACoreTable")}</label>
      {!readOnly ? <div className="inspector-actions"><button className="inspector-primary" type="submit" disabled={status === "saving"}>
        {bt("business.saveKnowledge")}</button></div> : null}
    </form>
  );
}
