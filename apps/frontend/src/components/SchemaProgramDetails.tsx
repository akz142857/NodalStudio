import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../i18n";
import type { DatabaseSnapshot, ObjectKey, ProgramDefinition, TableDefinition } from "../platform/types";

const same = (a: ObjectKey, b: ObjectKey) => a.kind === b.kind && a.schema === b.schema && a.name === b.name;
interface DependencyProps {
  snapshot: DatabaseSnapshot;
  objectKey: ObjectKey;
  onSelect?: (key: ObjectKey) => void;
  onSelectTable?: (table: TableDefinition) => void;
}
export function ObjectDependencies({ snapshot, objectKey, onSelect, onSelectTable }: DependencyProps) {
  const { t } = useI18n();
  const edges = snapshot.schemas.flatMap(s => s.dependencies ?? []);
  const link = (key: ObjectKey) => {
    const table = snapshot.schemas.flatMap(s => s.tables).find(table => same(table.key, key));
    const available = table ? Boolean(onSelectTable) : Boolean(onSelect) && snapshot.schemas.some(s => [...s.views, ...s.enums, ...(s.programs ?? [])].some(o => same(o.key, key)));
    return <li key={JSON.stringify(key)}>{available ? <button type="button" className="object-dependency-link" onClick={() => table ? onSelectTable?.(table) : onSelect?.(key)}>{key.schema}.{key.name}</button> : <span>{key.schema}.{key.name}</span>}</li>;
  };
  return <section className="object-dependencies inspector-section">
    <p className="muted-copy">{t("objects.coverage")}</p>
    {([false, true] as const).map(incoming => {
      const keys = edges.filter(e => same(incoming ? e.target : e.source, objectKey)).map(e => incoming ? e.source : e.target);
      return <div className="object-dependency-group" key={String(incoming)}><h3>{t(incoming ? "objects.dependents" : "objects.dependencies")}</h3>{keys.length ? <ul className="inspector-list">{keys.map(link)}</ul> : <p>{t("objects.none")}</p>}</div>;
    })}
  </section>;
}
interface Props extends Omit<DependencyProps, "objectKey"> {
  program: ProgramDefinition;
  onClose: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void;
}
export function ProgramDetails({ program, snapshot, onClose, onSelect, onSelectTable }: Props) {
  const { t } = useI18n();
  const detail = useRef<HTMLElement>(null);
  const identity = JSON.stringify(program.key);
  useEffect(() => {
    detail.current?.scrollIntoView?.({ block: "start" });
  }, [identity]);
  const kind = program.key.kind === "procedure" ? t("objects.procedure") : program.key.kind === "trigger" ? t("objects.trigger") : t("objects.function");
  const status = program.enabled === "O" ? t("objects.enabledO") : program.enabled === "D" ? t("objects.enabledD") : program.enabled === "R" ? t("objects.enabledR") : program.enabled === "A" ? t("objects.enabledA") : program.enabled === "enabled" ? t("objects.enabledA") : program.enabled;
  return <section ref={detail} className="ds-surface schema-object-preview schema-program-preview" aria-label={`${kind} ${program.key.name}`} onKeyDown={e => {if(e.key === "Escape") {e.stopPropagation(); onClose(e);}}}>
    <header><strong>{kind} · {program.key.schema}.{program.key.name}</strong><button type="button" aria-label={t("objects.close")} onClick={onClose}>×</button></header>
    <dl className="snapshot-summary">
      <div><dt>{t("objects.language")}</dt><dd>{program.language}</dd></div>
      <div><dt>{t("objects.owner")}</dt><dd>{program.owner}</dd></div>
      {program.arguments ? <div><dt>{t("objects.arguments")}</dt><dd>{program.arguments}</dd></div> : null}
      {program.resultType ? <div><dt>{t("objects.resultType")}</dt><dd>{program.resultType}</dd></div> : null}
      {program.table ? <div><dt>{t("objects.table")}</dt><dd>{program.table.schema}.{program.table.name}</dd></div> : null}
      {status ? <div><dt>{t("objects.enabled")}</dt><dd>{status}</dd></div> : null}
    </dl>
    <h3>{t("objects.definition")}</h3><pre tabIndex={0}>{program.definition ?? t("objects.unavailable")}</pre>
    <ObjectDependencies snapshot={snapshot} objectKey={program.key} onSelect={onSelect} onSelectTable={onSelectTable} />
  </section>;
}

export function TableCatalogDetails({snapshot, table, onOpenObject}: {snapshot: DatabaseSnapshot; table: TableDefinition; onOpenObject?: (key: ObjectKey) => void}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<ObjectKey>();
  const triggers = snapshot.schemas.flatMap(s => s.programs ?? []).filter(p => p.table && same(p.table, table.key));
  const program = triggers.find(p => selected && same(p.key, selected));
  return <>
    {triggers.length ? <section className="inspector-section"><h3>{t("objects.triggers")}</h3><ul className="inspector-list">{triggers.map(p => <li key={JSON.stringify(p.key)}><button type="button" className="object-dependency-link" aria-expanded={program === p} onClick={() => onOpenObject ? onOpenObject(p.key) : setSelected(p.key)}>{p.key.name}</button></li>)}</ul></section> : null}
    {program ? <ProgramDetails program={program} snapshot={snapshot} onClose={() => setSelected(undefined)}/> : null}
    <ObjectDependencies snapshot={snapshot} objectKey={table.key} onSelect={onOpenObject}/>
  </>;
}
