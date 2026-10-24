import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { DatabaseSnapshot, LogicalRelationship, RelationshipCardinality, RelationshipEndpoint, RelationshipValidation, SaveLogicalRelationshipInput } from "../../platform";
import { useUpdateBlocker } from "../../platform/update-guard";
import { relationshipCardinalityLabel } from "./relationship-labels";

export type ValidateRelationship = (input: { sourceId: string; source: RelationshipEndpoint; target: RelationshipEndpoint; relationshipId?: string }) => Promise<RelationshipValidation>;
interface Choice { value: string; label: string; detail?: string }

/** Search stays local; only choosing a result changes the endpoint. */
function SearchSelect({ label, value, options, onChange }: { label: string; value: string; options: Choice[]; onChange: (value: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const selected = options.find((item) => item.value === value);
  const matches = options.filter((item) => `${item.label} ${item.detail ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visible = matches.slice(0, 40);
  const choose = (item: Choice) => { onChange(item.value); setOpen(false); setQuery(""); };
  return <div className="relationship-search-select">
    <label htmlFor={id}>{label}</label>
    <input id={id} role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open && visible[index] ? `${id}-option-${index}` : undefined}
      placeholder={`Search ${label.toLowerCase()}…`} value={open ? query : selected?.label ?? (value ? `${value} (missing)` : "")}
      onFocus={() => { setOpen(true); setQuery(""); setIndex(0); }} onBlur={() => setOpen(false)}
      onChange={(event) => { setQuery(event.target.value); setIndex(0); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setIndex((current) => Math.max(0, Math.min(visible.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))); }
        if (event.key === "Enter" && open) { event.preventDefault(); if (visible[index]) choose(visible[index]); }
      }} />
    {open ? <div className="relationship-search-results" id={`${id}-options`} role="listbox" aria-label={`${label} options`}>
      {visible.map((item, position) => <button type="button" role="option" id={`${id}-option-${position}`} key={item.value} aria-selected={position === index} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}><span>{item.label}</span>{item.detail ? <small>{item.detail}</small> : null}</button>)}
      {!visible.length ? <p>No matching {label.toLowerCase()}.</p> : matches.length > visible.length ? <p>Showing 40 of {matches.length}. Type to narrow the results.</p> : null}
    </div> : null}
  </div>;
}

const emptyEndpoint = (): RelationshipEndpoint => ({ schema: "", table: "", columns: [""] });
const tableKey = (value: Pick<RelationshipEndpoint, "schema" | "table">) => JSON.stringify([value.schema, value.table]);
const cardinalities: RelationshipCardinality[] = ["manyToOne", "oneToOne", "oneToMany", "manyToMany", "unspecified"];

export function RelationshipEditor({ snapshot, relationship, onValidate, onSave, onSaved, onCancel, onStateChange }: {
  snapshot: DatabaseSnapshot;
  relationship?: LogicalRelationship;
  onValidate: ValidateRelationship;
  onSave: (input: SaveLogicalRelationshipInput) => Promise<LogicalRelationship>;
  onSaved: (relationship: LogicalRelationship) => void;
  onCancel: () => void;
  onStateChange: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  useUpdateBlocker("save or close the model relationship editor", true);
  const [source, setSource] = useState(relationship?.source ?? emptyEndpoint);
  const [target, setTarget] = useState(relationship?.target ?? emptyEndpoint);
  const [name, setName] = useState(relationship?.name ?? "");
  const [note, setNote] = useState(relationship?.note ?? "");
  const [cardinality, setCardinality] = useState<RelationshipCardinality | undefined>(relationship?.cardinality);
  const [allowTypeMismatch, setAllowTypeMismatch] = useState(relationship?.status === "conflicted");
  const [validationState, setValidationState] = useState<{ key: string; result?: RelationshipValidation; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const tables = useMemo(() => snapshot.schemas.flatMap((schema) => schema.tables).sort((a, b) => `${a.key.schema}.${a.key.name}`.localeCompare(`${b.key.schema}.${b.key.name}`)), [snapshot]);
  const tableOptions = useMemo(() => tables.map((table) => ({ value: tableKey({ schema: table.key.schema, table: table.key.name }), label: `${table.key.schema}.${table.key.name}`, detail: table.comment ?? undefined })), [tables]);
  const findTable = (endpoint: RelationshipEndpoint) => tables.find((table) => table.key.schema === endpoint.schema && table.key.name === endpoint.table);
  const sourceTable = findTable(source);
  const targetTable = findTable(target);
  const pairCount = Math.max(source.columns.length, target.columns.length, 1);
  const complete = source.columns.length === target.columns.length && source.columns.length > 0
    && source.columns.every((name) => sourceTable?.columns.some((column) => column.name === name))
    && target.columns.every((name) => targetTable?.columns.some((column) => column.name === name));
  const repeated = new Set(source.columns).size !== source.columns.length || new Set(target.columns).size !== target.columns.length;
  const validationInput = useMemo(() => ({ sourceId: snapshot.sourceId, source, target, relationshipId: relationship?.id }), [snapshot.sourceId, source, target, relationship?.id]);
  const validationKey = JSON.stringify([validationInput, retry]);
  const validation = validationState?.key === validationKey ? validationState.result : undefined;
  const validationError = validationState?.key === validationKey ? validationState.error : undefined;
  const dirty = JSON.stringify([source, target, name, note, cardinality, allowTypeMismatch]) !== JSON.stringify([relationship?.source ?? emptyEndpoint(), relationship?.target ?? emptyEndpoint(), relationship?.name ?? "", relationship?.note ?? "", relationship?.cardinality, relationship?.status === "conflicted"]);
  useEffect(() => { onStateChange({ dirty, saving }); }, [dirty, saving, onStateChange]);
  useEffect(() => {
    if (!complete || repeated) return;
    let active = true;
    void Promise.resolve().then(() => onValidate(validationInput)).then((result) => {
      if (active) setValidationState({ key: validationKey, result });
    }).catch((reason: unknown) => { if (active) setValidationState({ key: validationKey, error: reason instanceof Error ? reason.message : String(reason) }); });
    return () => { active = false; };
  }, [complete, repeated, onValidate, validationInput, validationKey]);
  const resolvedCardinality = cardinality ?? validation?.suggestedCardinality ?? "unspecified";
  const canSave = complete && !repeated && !saving && Boolean(validation && !validation.duplicate && !validation.physicalExists && (validation.valid || (!validation.compatible && validation.status === "conflicted" && allowTypeMismatch)));

  function changeTable(side: "source" | "target", value: string) {
    const [schema, table] = JSON.parse(value) as [string, string];
    const current = side === "source" ? source : target;
    if (schema === current.schema && table === current.table) return;
    (side === "source" ? setSource : setTarget)({ schema, table, columns: Array.from({ length: pairCount }, () => "") });
    setAllowTypeMismatch(false);
  }
  function changeColumn(side: "source" | "target", index: number, value: string) {
    (side === "source" ? setSource : setTarget)((endpoint) => ({ ...endpoint, columns: Array.from({ length: pairCount }, (_, position) => position === index ? value : endpoint.columns[position] ?? "") }));
    setAllowTypeMismatch(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || pending.current) return;
    pending.current = true; setSaving(true); setError("");
    try {
      const saved = await onSave({ id: relationship?.id, sourceId: snapshot.sourceId, source, target,
        name: name.trim() || `${source.table}_${source.columns.join("_")}_${target.table}_${target.columns.join("_")}`.slice(0, 160),
        note: note.trim() || null, cardinality: resolvedCardinality, origin: relationship?.origin ?? "manual", evidence: relationship?.evidence ?? [], disabled: relationship?.status === "disabled", allowTypeMismatch });
      onSaved(saved);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setSaving(false); }
  }
  return <form className="relationship-editor" aria-label={relationship ? "Edit logical relationship" : "Create logical relationship"} onSubmit={(event) => void submit(event)}>
    <div className="relationship-detail-heading"><div><h3>{relationship ? "Edit relationship" : "New relationship"}</h3><p>Choose tables, then map their fields.</p></div></div>
    <fieldset disabled={saving}>
      <div className="relationship-table-pickers"><SearchSelect label="Source table" value={source.table ? tableKey(source) : ""} options={tableOptions} onChange={(value) => changeTable("source", value)} /><SearchSelect label="Target table" value={target.table ? tableKey(target) : ""} options={tableOptions} onChange={(value) => changeTable("target", value)} /></div>
      <div className="relationship-field-mappings"><span className="relationship-section-label">Field mappings</span>
        {Array.from({ length: pairCount }, (_, index) => <div className="relationship-field-pair" key={index}>
          <SearchSelect label={`Source field ${index + 1}`} value={source.columns[index] ?? ""} options={sourceTable?.columns.map((column) => ({ value: column.name, label: column.name, detail: column.formattedType })) ?? []} onChange={(value) => changeColumn("source", index, value)} />
          <span aria-hidden="true">→</span>
          <SearchSelect label={`Target field ${index + 1}`} value={target.columns[index] ?? ""} options={targetTable?.columns.map((column) => ({ value: column.name, label: column.name, detail: column.formattedType })) ?? []} onChange={(value) => changeColumn("target", index, value)} />
          <button type="button" className="relationship-icon-button" aria-label={`Remove field pair ${index + 1}`} disabled={pairCount === 1} onClick={() => { setSource({ ...source, columns: source.columns.filter((_, i) => i !== index) }); setTarget({ ...target, columns: target.columns.filter((_, i) => i !== index) }); setAllowTypeMismatch(false); }}>×</button>
        </div>)}
        <button type="button" className="relationship-text-button" onClick={() => { setSource({ ...source, columns: [...source.columns, ""] }); setTarget({ ...target, columns: [...target.columns, ""] }); setAllowTypeMismatch(false); }}>＋ Add field pair</button>
      </div>
      <label>Relationship type<select value={resolvedCardinality} onChange={(event) => setCardinality(event.target.value as RelationshipCardinality)}>{cardinalities.map((value) => <option key={value} value={value}>{relationshipCardinalityLabel(value)}</option>)}</select></label>
      <label>Note<textarea rows={3} value={note} maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder="Describe the meaning of this relationship…" /></label>
      <details className="relationship-metadata"><summary>Relationship name</summary><label>Name (optional)<input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} placeholder="Generated from the field mapping" /></label></details>
      {validation?.compatible === false && validation.status === "conflicted" ? <label className="relationship-check"><input type="checkbox" checked={allowTypeMismatch} onChange={(event) => setAllowTypeMismatch(event.target.checked)} />Allow type mismatch and mark for review</label> : null}
    </fieldset>
    <div className="relationship-editor-validation" aria-live="polite">
      {!complete ? <p>Select an existing table and field for each side of every mapping.</p> : repeated ? <p role="alert">Each field can appear only once in this mapping.</p> : !validation && !validationError ? <p>Checking field mapping…</p> : null}
      {validation?.duplicate ? <p role="alert">This relationship already exists. Choose another mapping.</p> : validation?.physicalExists ? <p role="alert">A database foreign key already covers this mapping.</p> : null}
      {validation?.messages.length ? <ul>{validation.messages.map((message) => <li key={message}>{message}</li>)}</ul> : null}
      {validationError ? <p role="alert">{validationError} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry validation</button></p> : null}
      {error ? <p className="relationship-error" role="alert">{error}</p> : null}
    </div>
    <footer className="relationship-editor-footer"><button type="button" disabled={saving} onClick={onCancel}>Cancel</button><button type="submit" className="ds-primary" disabled={!canSave}>{saving ? "Saving…" : relationship ? "Save changes" : "Create relationship"}</button></footer>
  </form>;
}
