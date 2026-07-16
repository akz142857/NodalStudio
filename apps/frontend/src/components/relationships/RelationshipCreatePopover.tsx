import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  LogicalRelationship,
  RelationshipCardinality,
  RelationshipEndpoint,
  RelationshipValidation,
  SaveLogicalRelationshipInput,
} from "../../platform";

export interface RelationshipDraft {
  source: RelationshipEndpoint;
  target: RelationshipEndpoint;
  relationship?: LogicalRelationship;
  origin?: "manual" | "confirmedInference" | "imported";
  evidence?: string[];
}

interface RelationshipCreatePopoverProps {
  sourceId: string;
  draft: RelationshipDraft;
  onValidate: (input: {
    sourceId: string;
    source: RelationshipEndpoint;
    target: RelationshipEndpoint;
    relationshipId?: string;
  }) => Promise<RelationshipValidation>;
  onSave: (input: SaveLogicalRelationshipInput) => Promise<void>;
  onCancel: () => void;
}

function endpointLabel(endpoint: RelationshipEndpoint) {
  return `${endpoint.schema}.${endpoint.table}.${endpoint.columns.join(", ")}`;
}

function defaultName(source: RelationshipEndpoint, target: RelationshipEndpoint) {
  return `${source.table}_${source.columns.join("_")}_${target.table}_${target.columns.join("_")}`;
}

const cardinalityOptions: Array<{ value: RelationshipCardinality; label: string }> = [
  { value: "manyToOne", label: "Many to one" },
  { value: "oneToOne", label: "One to one" },
  { value: "oneToMany", label: "One to many" },
  { value: "manyToMany", label: "Many to many" },
  { value: "unspecified", label: "Unspecified" },
];

export function RelationshipCreatePopover({
  sourceId,
  draft,
  onValidate,
  onSave,
  onCancel,
}: RelationshipCreatePopoverProps) {
  const existing = draft.relationship;
  const [name, setName] = useState(existing?.name ?? defaultName(draft.source, draft.target));
  const [cardinality, setCardinality] = useState<RelationshipCardinality>(existing?.cardinality ?? "unspecified");
  const [note, setNote] = useState(existing?.note ?? "");
  const [allowTypeMismatch, setAllowTypeMismatch] = useState(existing?.status === "conflicted");
  const [validation, setValidation] = useState<RelationshipValidation>();
  const [status, setStatus] = useState<"validating" | "idle" | "saving" | "error">("validating");
  const [error, setError] = useState("");
  const validationInput = useMemo(() => ({
    sourceId,
    source: draft.source,
    target: draft.target,
    relationshipId: existing?.id,
  }), [draft.source, draft.target, existing?.id, sourceId]);

  useEffect(() => {
    let active = true;
    void onValidate(validationInput)
      .then((result) => {
        if (!active) return;
        setValidation(result);
        if (!existing) setCardinality((current) => current === "unspecified" ? result.suggestedCardinality : current);
        setStatus("idle");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus("error");
      });
    return () => { active = false; };
  }, [existing, onValidate, validationInput]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus("saving");
    setError("");
    try {
      await onSave({
        id: existing?.id,
        sourceId,
        name,
        source: draft.source,
        target: draft.target,
        cardinality,
        origin: draft.origin ?? existing?.origin ?? "manual",
        note: note || null,
        evidence: draft.evidence ?? existing?.evidence ?? [],
        disabled: existing?.status === "disabled",
        allowTypeMismatch,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  }

  const canSave = Boolean(name.trim())
    && status !== "validating"
    && status !== "saving"
    && Boolean(validation)
    && !validation?.duplicate
    && !validation?.physicalExists
    && (validation?.valid === true
      || (validation?.compatible === false && validation.status === "conflicted" && allowTypeMismatch));

  return (
    <div className="relationship-dialog-backdrop nodrag nopan" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <form className="relationship-dialog" aria-label={existing ? "Edit logical relationship" : "Create logical relationship"} onSubmit={(event) => void submit(event)}>
        <header>
          <div>
            <p>MODEL ONLY · NO DATABASE CONSTRAINT</p>
            <h2>{existing ? "Edit logical relationship" : "Create logical relationship"}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onCancel}>×</button>
        </header>
        <dl>
          <div><dt>From</dt><dd>{endpointLabel(draft.source)}</dd></div>
          <div><dt>To</dt><dd>{endpointLabel(draft.target)}</dd></div>
        </dl>
        <label>Name<input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label>Cardinality<select value={cardinality} onChange={(event) => setCardinality(event.target.value as RelationshipCardinality)}>{cardinalityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>Note<textarea rows={3} value={note} maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder="Why does this relationship exist?" /></label>
        {validation?.compatible === false ? <label className="relationship-mismatch"><input type="checkbox" checked={allowTypeMismatch} onChange={(event) => setAllowTypeMismatch(event.target.checked)} />Allow type mismatch and mark the relationship as conflicted</label> : null}
        {validation?.messages.length ? <ul className="relationship-validation" data-valid={validation.valid || undefined}>{validation.messages.map((message) => <li key={message}>{message}</li>)}</ul> : null}
        {error ? <p className="relationship-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={!canSave}>{status === "saving" ? "Saving…" : existing ? "Save changes" : "Create"}</button>
        </footer>
      </form>
    </div>
  );
}
