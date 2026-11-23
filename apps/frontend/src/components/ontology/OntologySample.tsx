import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { PaidOrdersSample } from "../../platform/ontology-types";
import { ActionIcon } from "../ActionIcon";

export function OntologySample({ sample, locked, busy, onSave }: {
  sample?: PaidOrdersSample;
  locked: boolean;
  busy: boolean;
  onSave: (sample: PaidOrdersSample) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [month, setMonth] = useState(sample?.month ?? "");
  const [orders, setOrders] = useState(sample?.expectedOrderIds.join("\n") ?? "");
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const monthInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const monthHintId = useId();
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month.trim());
  const invalidMonth = month.length === 7 && !validMonth;
  const showForm = !locked && (!sample || editing);
  useEffect(() => { if (editing) monthInput.current?.focus(); }, [editing]);

  function editSample() {
    setMonth(sample?.month ?? "");
    setOrders(sample?.expectedOrderIds.join("\n") ?? "");
    setSaved(false);
    setEditing(true);
  }

  function finishEditing() {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  }

  return <section className="ontology-sample" aria-label={t("ontology.sample")}>
    <div className="ontology-section-heading">
      <div>
        <h4><ActionIcon name="shield" />{t("ontology.sample")}</h4>
        {locked ? <p>{t("ontology.sampleLocked")}</p> : null}
      </div>
      {sample && !locked && !showForm ? <Button ref={editButton} disabled={busy} onClick={editSample}>{t("ontology.editSample")}</Button> : null}
    </div>
    {showForm ? <form className="ontology-field-group" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !validMonth) return;
      setSaved(false);
      const expectedOrderIds = orders.split(/\r?\n/).filter(Boolean);
      void onSave({ month: month.trim(), expectedOrderIds }).then((success) => {
        if (success) { finishEditing(); setSaved(true); }
      });
    }}>
      <div className="ontology-sample-fields">
        <div>
          <label>{t("ontology.sampleMonth")}<input ref={monthInput} required placeholder="YYYY-MM" maxLength={7} value={month} disabled={busy}
            aria-invalid={invalidMonth || undefined} aria-describedby={invalidMonth ? monthHintId : undefined}
            onChange={(event) => { setMonth(event.target.value); setSaved(false); }} /></label>
          {invalidMonth ? <p className="ontology-field-hint ontology-field-error" id={monthHintId}>{t("ontology.sampleMonthFormat")}</p> : null}
        </div>
        <label>{t("ontology.expectedOrders")}<textarea rows={3} maxLength={26000} value={orders} disabled={busy} aria-describedby={helpId}
          onChange={(event) => { setOrders(event.target.value); setSaved(false); }} /></label>
      </div>
      <p id={helpId} className="ontology-field-hint">{t("ontology.sampleHelp")}</p>
      <div className="ontology-actions">
        {sample ? <Button variant="ghost" disabled={busy} onClick={finishEditing}>{t("business.cancel")}</Button> : null}
        <Button type="submit" disabled={busy || !validMonth}>{t("ontology.saveSample")}</Button>
      </div>
    </form> : sample ? <dl className="ontology-summary">
      <dt>{t("ontology.sampleMonth")}</dt><dd>{sample.month}</dd>
      <dt>{t("ontology.expectedOrders")}</dt><dd><code>{sample.expectedOrderIds.join(", ") || t("ontology.emptySet")}</code></dd>
    </dl> : null}
    {saved && !locked ? <p className="ontology-success" role="status"><ActionIcon name="check" />{t("ontology.sampleSaved")}</p> : null}
  </section>;
}
