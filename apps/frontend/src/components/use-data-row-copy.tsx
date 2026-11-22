import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../i18n";
import { SchemaObjectMenu } from "./SchemaObjectMenu";
import type { RowStatements } from "./query/row-statements";

export type DataRowMenuEvent = MouseEvent<HTMLTableRowElement> | KeyboardEvent<HTMLTableRowElement>;

export function isDataRowMenuShortcut(event: KeyboardEvent) {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

interface CopyMenu {
  row: HTMLTableRowElement;
  name: string;
  x: number;
  y: number;
  fields: readonly string[];
  values: readonly string[];
  statements?: RowStatements;
  fieldName?: string;
}

function tsv(values: readonly string[]) {
  return values.map((value) => /["\t\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join("\t");
}

export function useDataRowCopy(scope: object | string | undefined) {
  const { t } = useI18n();
  const [storedScope, setStoredScope] = useState(scope);
  const [menu, setMenu] = useState<CopyMenu>();
  const [error, setError] = useState("");
  const operation = useRef(0);
  if (storedScope !== scope) {
    setStoredScope(scope);
    setMenu(undefined);
    setError("");
  }
  useLayoutEffect(() => () => { operation.current += 1; }, [scope]);

  function open(event: DataRowMenuEvent, name: string, fields: readonly string[], values: readonly string[], statements?: RowStatements) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget;
    const bounds = row.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    const cell = event.target instanceof Element ? event.target.closest("td") : null;
    const fieldIndex = cell ? Array.from(row.querySelectorAll("td")).indexOf(cell) : -1;
    setMenu({ row, name, fields, values, statements, fieldName: fields[fieldIndex],
      x: pointer ? event.clientX : Math.max(0, bounds.left) + 12,
      y: pointer ? event.clientY : bounds.bottom });
  }

  const copy = useCallback(async (text: string) => {
    const request = ++operation.current;
    setError("");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (operation.current === request) setError(t("business.unableToCopyCheckClipboardAccessAndRetry"));
    }
  }, [t]);

  const visible = storedScope === scope ? menu : undefined;
  const fieldName = visible?.fieldName;
  function statementAction(label: string, statement: RowStatements["insert"]) {
    return "sql" in statement
      ? { label, run: () => void copy(statement.sql) }
      : { label, disabled: true, description: t(`tableData.statement.${statement.reason}`), run: () => {} };
  }
  const sqlActions = visible?.statements ? [
    statementAction(t("tableData.copyInsert"), visible.statements.insert),
    statementAction(t("tableData.copyUpdate"), visible.statements.update),
  ] : [];
  const overlay = visible && <SchemaObjectMenu name={visible.name} x={visible.x} y={visible.y} showName={false}
    onClose={(restoreFocus) => {
      setMenu(undefined);
      if (restoreFocus && visible.row.isConnected) visible.row.focus({ preventScroll: true });
    }}
    actions={[
      { label: t("tableData.copyRow"), run: () => void copy(tsv(visible.values)) },
      ...(fieldName === undefined ? [] : [
        { label: t("tableData.copyFieldName"), run: () => void copy(fieldName) },
      ]),
      { label: t("tableData.copyAs"), children: [
        ...sqlActions,
        { label: t("tableData.copyWithHeaders"), separatorBefore: Boolean(visible.statements), run: () => void copy(`${tsv(visible.fields)}\n${tsv(visible.values)}`) },
        { label: t("tableData.copyFieldNames"), run: () => void copy(tsv(visible.fields)) },
      ] },
    ]} />;
  return { open, copy, overlay, error: storedScope === scope ? error : "" };
}
