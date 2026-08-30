import { type FormEvent, useState } from "react";
import type { ObjectAnnotation, SaveAnnotationInput, TableDefinition } from "../platform";

interface TableStructureProps {
  table: TableDefinition;
  onOpenQuery?: (table: TableDefinition) => void;
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
export function TableStructure({ table, onOpenQuery }: TableStructureProps) {
  const primaryColumns = new Set(table.primaryKey?.columns ?? []);
  const foreignColumns = new Set(table.foreignKeys.flatMap((key) => key.columns));

  return (
    <>
      <p className="inspector-comment">{table.comment ?? `${table.key.schema}.${table.key.name}`}</p>
      {onOpenQuery ? <button type="button" className="inspector-query-button" onClick={() => onOpenQuery(table)}>Preview rows in Query</button> : null}
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

      <section className="inspector-section">
        <h3>Columns</h3>
        <div className="inspector-columns">
          {table.columns.map((column) => (
            <div key={column.name}>
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
              <li key={key.name}>
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
              <li key={index.name}>
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
              <li key={constraint.name}>
                <strong>{constraint.name}</strong>
                <span>{constraint.definition}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
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

  async function saveAnnotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    try {
      await onSaveAnnotation({
        sourceId,
        objectKey: table.key,
        description: description || null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
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
      <button type="submit" disabled={status === "saving"}>
        Save knowledge
      </button>
    </form>
  );
}
