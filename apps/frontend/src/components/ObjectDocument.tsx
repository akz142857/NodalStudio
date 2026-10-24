import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { sqlLanguage } from "./query/sql-validation";
import { sqlHighlightStyle } from "../design-system/sql-highlight";
import { useI18n } from "../i18n";
import type { DatabaseSnapshot, ObjectKey, TableDefinition } from "../platform/types";
import { Segmented } from "./Segmented";
import { ObjectDependencies } from "./SchemaProgramDetails";
import { SchemaIndexDetails } from "./SchemaIndexDetails";
import "./object-document.css";

import type { DocumentObject } from "./object-document-model";
export function ObjectDocument({ snapshot, object, onClose, onSelect, onSelectTable }: {
  snapshot: DatabaseSnapshot; object: DocumentObject; onClose: () => void;
  onSelect: (key: ObjectKey) => void; onSelectTable: (table: TableDefinition) => void;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<"definition" | "properties" | "dependencies">("definition");
  const [wrap, setWrap] = useState(true);
  const [copyStatus, setCopyStatus] = useState("");
  const definition = "values" in object ? object.values.join("\n") : object.definition;
  const kind = object.key.kind === "view" ? ("materialized" in object && object.materialized ? t("business.materializedView") : t("business.view")) : object.key.kind === "procedure" ? t("objects.procedure") : object.key.kind === "trigger" ? t("objects.trigger") : object.key.kind === "enum" ? t("business.enums") : t("objects.function");
  return <section className="ds-surface object-document" aria-label={t("document.label")}>
    <header className="object-document-header">
      <button type="button" onClick={onClose}>← {t("document.diagram")}</button>
      <div><small>{kind} · {object.key.schema}</small><h2>{object.key.name}</h2></div>
      <button type="button" aria-label={t("objects.close")} onClick={onClose}>×</button>
    </header>
    <div className="object-document-toolbar">
      <Segmented label={t("document.sections")} value={section} onChange={setSection} options={[{ value: "definition", label: t("document.definition") }, { value: "properties", label: t("document.properties") }, { value: "dependencies", label: t("objects.dependencies") }]} />
      {section === "definition" ? <div className="object-document-actions"><button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{t("document.wrap")}</button><button type="button" disabled={!definition} onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(definition ?? "")).then(() => setCopyStatus(t("document.copied")), () => setCopyStatus(t("document.copyFailed"))); }}>{t("document.copy")}</button></div> : null}
    </div>
    {copyStatus ? <p className="object-document-status" role="status">{copyStatus}</p> : null}
    {section === "definition" ? definition ? <DefinitionReader value={definition} wrap={wrap} dialect={snapshot.database.databaseType === "mySql" ? "mySql" : "postgreSql"} /> : <p className="object-document-empty">{t("objects.unavailable")}</p> : <div className="object-document-content">
      {section === "dependencies" ? <ObjectDependencies snapshot={snapshot} objectKey={object.key} onSelect={onSelect} onSelectTable={onSelectTable} /> : <>
        <ObjectDocumentProperties object={object} />
      </>}
    </div>}
  </section>;
}

function DefinitionReader({ value, wrap, dialect }: { value: string; wrap: boolean; dialect: "postgreSql" | "mySql" }) {
  const { t } = useI18n();
  const label = t("document.reader");
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const [search, setSearch] = useState("");
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), sqlLanguage(dialect), syntaxHighlighting(sqlHighlightStyle), keymap.of(defaultKeymap),
      ...(wrap ? [EditorView.lineWrapping] : []),
      EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0", role: "textbox", "aria-readonly": "true" }),
      EditorView.theme({ "&": { height: "100%", color: "var(--ds-text)", backgroundColor: "var(--ds-surface)" }, ".cm-scroller": { overflow: "auto", fontFamily: "monospace" }, ".cm-gutters": { backgroundColor: "var(--ds-window)", color: "var(--ds-secondary)", borderColor: "var(--ds-separator)" } }),
    ] }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
  }, [value, wrap, dialect, label]);
  const find = () => {
    const editor = view.current;
    if (!editor || !search) return;
    const text = value.toLocaleLowerCase(); const needle = search.toLocaleLowerCase();
    const start = editor.state.selection.main.to;
    const next = text.indexOf(needle, start); const from = next < 0 ? text.indexOf(needle) : next;
    setNotFound(from < 0);
    if (from >= 0) editor.dispatch({ selection: { anchor: from, head: from + search.length }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  };
  return <div className="object-definition-reader"><form className="object-definition-search" onSubmit={e => { e.preventDefault(); find(); }}><input type="search" aria-label={t("document.search")} placeholder={t("document.search")} value={search} onChange={e => { setSearch(e.target.value); setNotFound(false); }} /><button type="submit" disabled={!search}>{t("document.findNext")}</button>{notFound ? <span role="status">{t("document.noMatch")}</span> : null}</form><div className="object-definition-code" ref={host} /></div>;
}

export function ObjectDocumentProperties({ object }: { object: DocumentObject }) {
  const { t } = useI18n();
  const program = "arguments" in object ? object : undefined;
  const kind = object.key.kind === "view" ? ("materialized" in object && object.materialized ? t("business.materializedView") : t("business.view")) : object.key.kind === "procedure" ? t("objects.procedure") : object.key.kind === "trigger" ? t("objects.trigger") : object.key.kind === "enum" ? t("business.enums") : t("objects.function");
  const enabled = program?.enabled;
  const status = enabled === "O" ? t("objects.enabledO") : enabled === "D" ? t("objects.enabledD") : enabled === "R" ? t("objects.enabledR") : enabled === "A" || enabled === "enabled" ? t("objects.enabledA") : enabled;
  return <section className="object-properties-panel" aria-label={t("document.properties")}>
        <dl className="object-document-properties">
          <div><dt>{t("document.type")}</dt><dd>{kind}</dd></div>
          <div><dt>{t("document.name")}</dt><dd>{object.key.schema}.{object.key.name}</dd></div>
          {program ? <>
            <div><dt>{t("objects.language")}</dt><dd>{program.language || "—"}</dd></div>
            <div><dt>{t("objects.owner")}</dt><dd>{program.owner || "—"}</dd></div>
            {program.arguments ? <div><dt>{t("objects.arguments")}</dt><dd>{program.arguments}</dd></div> : null}
            {program.resultType ? <div><dt>{t("objects.resultType")}</dt><dd>{program.resultType}</dd></div> : null}
            {program.table ? <div><dt>{t("objects.table")}</dt><dd>{program.table.schema}.{program.table.name}</dd></div> : null}
            {status ? <div><dt>{t("objects.enabled")}</dt><dd>{status}</dd></div> : null}
          </> : null}
        </dl>
        {"comment" in object && object.comment ? <p>{object.comment}</p> : null}
        {"materialized" in object ? <SchemaIndexDetails indexes={object.indexes ?? []} /> : null}
  </section>;
}
