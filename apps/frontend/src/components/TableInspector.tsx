import { useUpdateBlocker } from "../platform/update-guard";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ObjectAnnotation, SaveAnnotationInput, TableAiEvidence, TableDefinition } from "../platform";

interface TableStructureProps {
  table: TableDefinition;
  onOpenQuery?: (table: TableDefinition) => void;
  focusedEvidence?: TableAiEvidence;
}

interface TableKnowledgeFormProps {
  table: TableDefinition;
  sourceId: string;
  annotation?: ObjectAnnotation;
  onSaveAnnotation: (input: SaveAnnotationInput) => Promise<void>;
}

/**
 * What the database says about a table: shape, keys, indexes, constraints.
 *
 * Split from the knowledge form because the inspector shows one or the other —
 * structure is read-only and comes from the snapshot, the form is authored.
 */
export function TableStructure({ table, onOpenQuery, focusedEvidence }: TableStructureProps) {
  const structure = useRef<HTMLDivElement>(null);
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

  return (
    <div ref={structure} className="table-structure">
      <p className="inspector-comment" tabIndex={-1} data-evidence-target={focusedEvidence?.kind !== "logicalRelationship" && focused("table", table.key.name) ? "true" : undefined}>{table.comment ?? `${table.key.schema}.${table.key.name}`}</p>
      <dl className="snapshot-summary">
        <div>
          <dt>Kind</dt>
          <dd>{table.tableKind}</dd>
        </div>
        <div>
          <dt>Columns</dt>
          <dd>{table.columns.length}</dd>
        </div>
        <div>
          <dt>Relationships</dt>
          <dd>{table.foreignKeys.length}</dd>
        </div>
      </dl>
      {onOpenQuery ? <div className="inspector-actions"><button type="button" className="inspector-query-button" onClick={() => onOpenQuery(table)}>Preview rows in Query</button></div> : null}

      <section className="inspector-section">
        <h3>Columns</h3>
        <div className="inspector-columns">
          {table.columns.map((column) => (
            <div key={column.name} tabIndex={-1} data-evidence-target={focused("column", column.name) || logicalField === column.name ? "true" : undefined} data-evidence-focus={focused("column", column.name) || focusedEvidence?.columns.includes(column.name) ? "true" : undefined}>
              <span>
                {primaryColumns.has(column.name) ? <b>PK</b> : null}
                {foreignColumns.has(column.name) ? <b>FK</b> : null}
                <strong>{column.name}</strong>
              </span>
              <small>
                {column.formattedType}
                {column.nullable ? "" : " · not null"}
              </small>
              {column.comment ? <p>{column.comment}</p> : null}
            </div>
          ))}
        </div>
      </section>

      {table.foreignKeys.length > 0 ? (
        <section className="inspector-section">
          <h3>Relationships</h3>
          <ul className="inspector-list">
            {table.foreignKeys.map((key) => (
              <li key={key.name} tabIndex={-1} data-evidence-target={focused("foreignKey", key.name) ? "true" : undefined} data-evidence-focus={focused("foreignKey", key.name) ? "true" : undefined}>
                <strong>{key.name}</strong>
                <span>
                  {key.columns.join(", ")} → {key.referencedSchema}.{key.referencedTable}(
                  {key.referencedColumns.join(", ")})
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {table.indexes.length > 0 ? (
        <section className="inspector-section">
          <h3>Indexes</h3>
          <ul className="inspector-list">
            {table.indexes.map((index) => (
              <li key={index.name} tabIndex={-1} data-evidence-target={focused("index", index.name) ? "true" : undefined} data-evidence-focus={focused("index", index.name) ? "true" : undefined}>
                <strong>{index.name}</strong>
                <span>
                  {index.method} · {index.columns.join(", ")}
                  {index.unique ? " · unique" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {table.constraints.length > 0 ? (
        <section className="inspector-section">
          <h3>Constraints</h3>
          <ul className="inspector-list">
            {table.constraints.map((constraint) => (
              <li key={constraint.name} tabIndex={-1} data-evidence-target={focused("constraint", constraint.name) ? "true" : undefined} data-evidence-focus={focused("constraint", constraint.name) ? "true" : undefined}>
                <strong>{constraint.name}</strong>
                <span>{constraint.definition}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** What the team says about a table. The physical model stays read-only. */
export function TableKnowledgeForm({
  table,
  sourceId,
  annotation,
  onSaveAnnotation,
}: TableKnowledgeFormProps) {
  const [description, setDescription] = useState(annotation?.description ?? "");
  const [tags, setTags] = useState(annotation?.tags.join(", ") ?? "");
  const [owner, setOwner] = useState(annotation?.owner ?? "");
  const [isCore, setIsCore] = useState(annotation?.isCore ?? false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string>();

  const normalizedTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  useUpdateBlocker("save or discard table knowledge edits", status === "saving" || description !== (annotation?.description ?? "") || JSON.stringify(normalizedTags) !== JSON.stringify(annotation?.tags ?? []) || owner !== (annotation?.owner ?? "") || isCore !== (annotation?.isCore ?? false));

  async function saveAnnotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
        <h3>Team knowledge</h3>
        <span data-status={status}>
          {status === "saving"
            ? "Saving…"
            : status === "saved"
              ? "Saved"
              : status === "error"
                ? (error ?? "Save failed")
                : "Editable"}
        </span>
      </div>
      <label>
        Description
        <textarea
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What business role does this table play?"
        />
      </label>
      <label>
        Tags
        <input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder="identity, billing, core"
        />
      </label>
      <label>
        Owner
        <input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="Team or person"
        />
      </label>
      <label className="core-toggle">
        <input
          type="checkbox"
          checked={isCore}
          onChange={(event) => setIsCore(event.target.checked)}
        />
        Mark as a core table
      </label>
      <div className="inspector-actions"><button className="inspector-primary" type="submit" disabled={status === "saving"}>
        Save knowledge
      </button></div>
    </form>
  );
}
