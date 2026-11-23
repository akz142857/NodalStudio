import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { DatabaseSnapshot, ObjectKey, TableDefinition } from "../../platform";
import type { BusinessTimeZone, PaidOrdersDefinition, PaymentTimeStorage } from "../../platform/ontology-types";
import type { ColumnDefinition } from "../../platform/types";
import { ActionIcon } from "../ActionIcon";
import { SearchSelect, type SearchChoice } from "../SearchSelect";

interface Props {
  snapshot: DatabaseSnapshot;
  definition: PaidOrdersDefinition;
  disabled: boolean;
  lockTimeZone?: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
  submitVariant?: "primary" | "secondary";
  title: string;
  children?: ReactNode;
  onChange: (definition: PaidOrdersDefinition) => void;
  onConfirm: () => void;
  onCancel?: () => void;
}

function tableId(key: ObjectKey) {
  return JSON.stringify([key.schema, key.name]);
}

interface TableChoice extends SearchChoice {
  table: TableDefinition;
}

type Engine = DatabaseSnapshot["database"]["databaseType"];

function isStatusField(engine: Engine, field: ColumnDefinition) {
  switch (engine) {
    case "postgreSql": return field.typeSchema === "pg_catalog" && ["text", "varchar", "bpchar"].includes(field.typeName);
    case "mySql": return ["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum"].includes(field.typeName);
    case "sqlite": return field.typeName === "TEXT";
  }
}

function storageOptions(engine: Engine, field: ColumnDefinition): PaymentTimeStorage[] | undefined {
  switch (engine) {
    case "postgreSql": return field.typeSchema === "pg_catalog" && field.typeName === "timestamptz" ? [] : undefined;
    case "mySql":
      if (field.typeName === "timestamp") return [];
      if (field.typeName === "datetime") return ["utcDateTime", "singaporeDateTime"];
      return undefined;
    case "sqlite": {
      if (field.typeName === "INTEGER") return ["unixSeconds", "unixMilliseconds"];
      const declaredType = field.formattedType.split("(")[0].trim().toUpperCase();
      if (field.typeName === "TEXT" || ["DATE", "DATETIME", "TIMESTAMP"].includes(declaredType)) return ["iso8601"];
      return undefined;
    }
  }
}

export function DefinitionEditor({ snapshot, definition, disabled, lockTimeZone, submitLabel, submitDisabled, submitVariant = "primary", title, children, onChange, onConfirm, onCancel }: Props) {
  const { t } = useI18n();
  const headingId = useId();
  const orderHintId = useId();
  const timeHintId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const focusName = Boolean(onCancel);
  useEffect(() => { if (focusName) nameInput.current?.focus(); }, [focusName]);
  const tables = useMemo<TableChoice[]>(() => snapshot.schemas.flatMap((schema) => schema.tables.map((table) => ({
    table, value: tableId(table.key), label: `${table.key.schema}.${table.key.name}`, searchName: table.key.name,
  }))), [snapshot]);
  const { order, payment } = definition;
  const orderTable = tables.find((choice) => choice.value === tableId(order.table))?.table;
  const paymentTable = tables.find((choice) => choice.value === tableId(payment.table))?.table;
  const orderKeys = orderTable?.primaryKey?.columns.length === 1 ? orderTable.primaryKey.columns : [];
  const paymentFields = paymentTable?.columns ?? [];
  const paymentOrderKeys = paymentFields.map((field) => field.name);
  const engine = snapshot.database.databaseType;
  const statusFields = paymentFields.filter((field) => isStatusField(engine, field)).map((field) => field.name);
  const timeFields = new Map(paymentFields.flatMap((field) => {
    const options = storageOptions(engine, field);
    return options ? [[field.name, options] as const] : [];
  }));
  const timeOptions = timeFields.get(payment.paidAtColumn) ?? [];
  const hasStorage = timeOptions.length ? timeOptions.some((option) => option === payment.timeStorage) : !payment.timeStorage;
  const isoSelected = payment.timeStorage === "iso8601" && timeOptions.includes("iso8601");
  const hasBindings = orderKeys.includes(order.idColumn) && paymentOrderKeys.includes(payment.orderIdColumn)
    && statusFields.includes(payment.statusColumn) && timeFields.has(payment.paidAtColumn) && hasStorage;
  const hasNames = [definition.name, order.name, payment.name, payment.successValue].every((value) => value.trim());
  const setOrder = (value: Partial<PaidOrdersDefinition["order"]>) => onChange({ ...definition, order: { ...order, ...value } });
  const setPayment = (value: Partial<PaidOrdersDefinition["payment"]>) => onChange({ ...definition, payment: { ...payment, ...value } });

  return <form className="ontology-editor" aria-labelledby={headingId} onKeyDown={(event) => {
    if (event.key !== "Escape" || disabled || !onCancel || event.target instanceof HTMLSelectElement) return;
    event.stopPropagation();
    onCancel();
  }} onSubmit={(event) => {
    event.preventDefault();
    if (!disabled && !submitDisabled && hasBindings && hasNames) onConfirm();
  }}>
    <header className="ontology-editor-heading">
      <h3 id={headingId}>{title}</h3>
      {onCancel ? <p>{t("ontology.recipe")}</p> : null}
    </header>
    <div className="ontology-field-group">
      <div className="ontology-editor-grid">
        <label>{t("ontology.name")}<input ref={nameInput} required maxLength={120} value={definition.name} disabled={disabled}
          onChange={(event) => onChange({ ...definition, name: event.target.value })} /></label>
        <label>{t("ontology.timeZone")}<select value={definition.timeZone} disabled={disabled || lockTimeZone}
          onChange={(event) => onChange({ ...definition, timeZone: event.target.value as BusinessTimeZone })}>
          <option value="UTC">UTC</option><option value="Asia/Singapore">Asia/Singapore</option>
        </select></label>
      </div>
    </div>
    <fieldset disabled={disabled}>
      <legend><ActionIcon name="table" />{t("ontology.orderObject")}</legend>
      <div className="ontology-field-group">
        <div className="ontology-editor-grid">
          <TableSelect tables={tables} value={order.table} disabled={disabled} onChange={(table) => setOrder({ table, idColumn: "" })} />
          <FieldSelect label={t("ontology.orderId")} options={orderKeys} value={order.idColumn} disabled={disabled} onChange={(idColumn) => setOrder({ idColumn })}
            description={orderTable && !orderKeys.length ? orderHintId : undefined} />
          <label>{t("ontology.objectName")}<input required maxLength={120} value={order.name} onChange={(event) => setOrder({ name: event.target.value })} /></label>
        </div>
        {orderTable && !orderKeys.length ? <p className="ontology-field-hint" id={orderHintId}>{t("ontology.singleKeyRequired")}</p> : null}
      </div>
    </fieldset>
    <fieldset disabled={disabled}>
      <legend><ActionIcon name="relationships" />{t("ontology.paymentObject")}</legend>
      <div className="ontology-field-group">
        <div className="ontology-editor-grid">
          <TableSelect tables={tables} value={payment.table} disabled={disabled} onChange={(table) => setPayment({ table, orderIdColumn: "", statusColumn: "", paidAtColumn: "", timeStorage: undefined })} />
          <FieldSelect label={t("ontology.paymentOrderId")} options={paymentOrderKeys} value={payment.orderIdColumn} disabled={disabled} onChange={(orderIdColumn) => setPayment({ orderIdColumn })} />
          <FieldSelect label={t("ontology.paymentStatus")} options={statusFields} value={payment.statusColumn} disabled={disabled} onChange={(statusColumn) => setPayment({ statusColumn })} />
          <label>{t("ontology.successValue")}<input required maxLength={120} value={payment.successValue}
            onChange={(event) => setPayment({ successValue: event.target.value })} /></label>
          <FieldSelect label={t("ontology.paymentTime")} options={[...timeFields.keys()]} value={payment.paidAtColumn} disabled={disabled}
            onChange={(paidAtColumn) => setPayment({ paidAtColumn, timeStorage: timeFields.get(paidAtColumn)?.find((option) => option === payment.timeStorage) })} />
          {timeOptions.length ? <label>{t(engine === "mySql" ? "ontology.storageTimeZone" : "ontology.timeStorage")}
            <select required value={hasStorage ? payment.timeStorage : ""} aria-describedby={isoSelected ? timeHintId : undefined}
              onChange={(event) => setPayment({ timeStorage: timeOptions.find((option) => option === event.target.value) })}>
              <option value="">{t("ontology.chooseTimeStorage")}</option>
              {timeOptions.map((option) => <option key={option} value={option}>{t(`ontology.storage.${option}`)}</option>)}
            </select>
          </label> : null}
          <label>{t("ontology.objectName")}<input required maxLength={120} value={payment.name} onChange={(event) => setPayment({ name: event.target.value })} /></label>
        </div>
        {isoSelected ? <p id={timeHintId} className="ontology-field-hint">{t("ontology.isoTimeHint")}</p> : null}
      </div>
    </fieldset>
    {children}
    <footer>
      {onCancel ? <Button onClick={onCancel} disabled={disabled}>{t("business.cancel")}</Button> : null}
      <Button type="submit" variant={submitVariant} disabled={disabled || submitDisabled || !hasBindings || !hasNames}>{submitLabel ?? t("ontology.confirm")}</Button>
    </footer>
  </form>;
}

function TableSelect({ tables, value, disabled, onChange }: {
  tables: TableChoice[];
  value: ObjectKey;
  disabled: boolean;
  onChange: (table: ObjectKey) => void;
}) {
  const { t } = useI18n();
  return <SearchSelect label={t("ontology.table")} value={value.name ? tableId(value) : ""} options={tables}
    placeholder={t("ontology.chooseTable")} searchPlaceholder={t("ontology.searchTable")}
    missingLabel={`${value.schema}.${value.name} · ${t("ontology.missingTable")}`}
    disabled={disabled || !tables.length} required onChange={(selected) => {
      const table = tables.find((choice) => choice.value === selected)?.table;
      if (table) onChange(table.key);
    }} />;
}

function FieldSelect({ label, value, options, disabled, onChange, description }: {
  label: string;
  value: string;
  options: string[];
  disabled: boolean;
  onChange: (field: string) => void;
  description?: string;
}) {
  const { t } = useI18n();
  return <SearchSelect label={label} value={value} options={options.map((option) => ({ value: option, label: option }))}
    placeholder={t("ontology.chooseColumn")} searchPlaceholder={t("ontology.searchColumn")}
    missingLabel={`${value} · ${t("ontology.missingColumn")}`} describedBy={description}
    disabled={disabled || !options.length} required onChange={onChange} />;
}
