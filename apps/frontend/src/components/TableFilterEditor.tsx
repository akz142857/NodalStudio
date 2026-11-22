import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
import {
  filterOperatorGroups, MAX_FILTER_RULES, MAX_FILTER_VALUE_BYTES, tableFilterRule,
  type TableFilterCondition, type TableFilterOperator, type TableFilterSettings,
} from "../platform/table-data-filter";

interface Condition extends Omit<TableFilterCondition, "column"> {
  id: number;
  column?: string;
}

const initialCondition: Condition = { id: 0, enabled: true, kind: "contains", value: "", end: "" };

export function TableFilterEditor({ id, hidden, columns, applied, busy, failed, disabled, onChange }: {
  id: string;
  hidden: boolean;
  columns: readonly string[];
  applied?: TableFilterSettings;
  busy?: boolean;
  failed?: boolean;
  disabled?: boolean;
  onChange: (settings?: TableFilterSettings) => void;
}) {
  const { t } = useI18n();
  const [conditions, setConditions] = useState<Condition[]>(() =>
    applied?.conditions.map((condition, id) => ({ ...condition, id })) ?? [initialCondition]);
  const [match, setMatch] = useState<TableFilterSettings["match"]>(() => applied?.match ?? "all");
  const form = useRef<HTMLFormElement>(null);
  const focusColumn = useRef<number>(undefined);
  const nextSettings = { match, conditions: conditions.map(({ enabled, column, kind, value, end }) => ({
    enabled, column: column ?? columns[0] ?? "", kind, value, end,
  })) };
  const complete = nextSettings.conditions.every((condition) =>
    !condition.enabled || (columns.includes(condition.column) && tableFilterRule(condition)));
  const unchanged = complete && applied !== undefined && JSON.stringify(nextSettings) === JSON.stringify(applied);
  const canApply = columns.length > 0 && complete && !unchanged && !busy && !disabled;
  const hasEnabledCondition = nextSettings.conditions.some(({ enabled }) => enabled);

  useLayoutEffect(() => {
    const conditionId = focusColumn.current;
    if (conditionId === undefined) return;
    focusColumn.current = undefined;
    form.current?.querySelector<HTMLSelectElement>(`[data-condition-id="${conditionId}"] .table-filter-column`)?.focus();
  }, [conditions]);

  function updateCondition(id: number, change: Partial<Omit<Condition, "id">>) {
    setConditions((current) => current.map((condition) => condition.id === id ? { ...condition, ...change } : condition));
  }

  return (
    <form ref={form} id={id} className="table-data-filters" hidden={hidden} aria-label={t("tableData.filter")} onSubmit={(event) => {
      event.preventDefault();
      if (canApply) onChange(nextSettings);
    }}>
      <fieldset disabled={disabled || !columns.length}>
        <div className="table-filter-heading">
          <select className="ds-select" aria-label={t("tableData.filterMatch")} value={match}
            onChange={(event) => setMatch(event.target.value === "any" ? "any" : "all")}>
            <option value="all">{t("tableData.filterMatchAll")}</option>
            <option value="any">{t("tableData.filterMatchAny")}</option>
          </select>
          <Button variant="ghost" className="table-filter-add" disabled={conditions.length >= MAX_FILTER_RULES} onClick={() => {
            const id = (conditions.at(-1)?.id ?? 0) + 1;
            focusColumn.current = id;
            setConditions((current) => [...current, { ...initialCondition, id }]);
          }}>{t("tableData.filterAddCondition")}</Button>
        </div>
        {conditions.map(({ id, enabled, column, kind, value, end }, index) => {
          const isMissing = kind === "isNull" || kind === "isNotNull" || kind === "isEmpty" || kind === "isNotEmpty";
          const isRange = kind === "between" || kind === "notBetween";
          const isList = kind === "inList" || kind === "notInList";
          const selectedColumn = column ?? columns[0] ?? "";
          return (
            <div className="table-filter-condition" data-condition-id={id} data-inactive={!enabled || undefined} role="group"
              aria-label={t("tableData.filterCondition", { value0: index + 1 })} key={id}>
              <label className="table-filter-toggle">
                <input type="checkbox" aria-label={t("tableData.filterUseCondition", { value0: index + 1 })}
                  checked={enabled} onChange={(event) => updateCondition(id, { enabled: event.target.checked })} />
              </label>
              <select className="ds-select table-filter-column" aria-label={t("tableData.filterColumn")} value={selectedColumn}
                onChange={(event) => updateCondition(id, { column: event.target.value })}>
                {!columns.includes(selectedColumn) && <option value={selectedColumn} disabled>{selectedColumn || t("tableData.filterColumn")}</option>}
                {columns.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <select className="ds-select table-filter-operator" aria-label={t("tableData.filterOperator")} value={kind}
                onChange={(event) => updateCondition(id, { kind: event.target.value as TableFilterOperator })}>
                {Object.entries(filterOperatorGroups).map(([group, operators]) => (
                  <optgroup key={group} label={t(`tableData.filterGroup.${group as keyof typeof filterOperatorGroups}`)}>
                    {operators.map((operator) => <option key={operator} value={operator}>{t(`tableData.filterOp.${operator}`)}</option>)}
                  </optgroup>
                ))}
              </select>
              {!isMissing && <div className="table-filter-values" data-range={isRange || undefined}>
                {isList ? <textarea aria-label={t("tableData.filterListValues")} placeholder={t("tableData.filterListValues")}
                  rows={2} maxLength={MAX_FILTER_VALUE_BYTES} value={value} onChange={(event) => updateCondition(id, { value: event.target.value })} />
                  : <input type="search" aria-label={t("tableData.filterValue")} placeholder={t("tableData.filterValue")}
                    maxLength={MAX_FILTER_VALUE_BYTES} value={value} onChange={(event) => updateCondition(id, { value: event.target.value })} />}
                {isRange && <input type="search" aria-label={t("tableData.filterEndValue")} placeholder={t("tableData.filterEndValue")}
                  maxLength={MAX_FILTER_VALUE_BYTES} value={end} onChange={(event) => updateCondition(id, { end: event.target.value })} />}
              </div>}
              {conditions.length > 1 && <Button variant="ghost" className="table-filter-remove"
                title={t("tableData.filterRemoveCondition", { value0: index + 1 })}
                aria-label={t("tableData.filterRemoveCondition", { value0: index + 1 })} onClick={() => {
                  focusColumn.current = (conditions[index + 1] ?? conditions[index - 1])?.id;
                  setConditions((current) => current.filter((condition) => condition.id !== id));
                }}>−</Button>}
            </div>
          );
        })}
      </fieldset>
      <div className="table-filter-footer">
        <div className="table-filter-actions">
          {applied && <Button variant="ghost" onClick={() => {
            focusColumn.current = initialCondition.id;
            setConditions([initialCondition]);
            setMatch("all");
            onChange();
          }} disabled={disabled}>{t("tableData.clearFilter")}</Button>}
          <Button type="submit" variant="primary" disabled={!canApply}>{t("tableData.applyFilter")}</Button>
        </div>
        <span className="table-filter-status" role="status" data-applied={Boolean(applied && unchanged && hasEnabledCondition && !busy && !failed)}>
          {applied && !busy && (unchanged
            ? !failed && t(hasEnabledCondition ? "tableData.filterApplied" : "tableData.filterAllConditionsOff")
            : t("tableData.filterUnapplied"))}
        </span>
      </div>
    </form>
  );
}
