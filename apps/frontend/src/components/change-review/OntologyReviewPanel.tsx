import { useState } from "react";
import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { DatabaseSnapshot } from "../../platform";
import type { ChangeReviewItem } from "../../platform/change-review-types";
import type { OntologyReviewEvidence, PaidOrdersDefinition } from "../../platform/ontology-types";
import { ontologySelectionKey } from "../../platform/ontology-types";
import { ActionIcon } from "../ActionIcon";
import { DefinitionEditor } from "../ontology/DefinitionEditor";
import "../ontology/ontology.css";

interface Props {
  item: ChangeReviewItem;
  snapshot?: DatabaseSnapshot;
  busy: boolean;
  onVerify: (definition: PaidOrdersDefinition, basis: string) => void;
  onClose: (checkId: string) => void;
  onOpenDefinition?: (id: string) => void;
}

export function OntologyReviewPanel({ item, snapshot, busy, onVerify, onClose, onOpenDefinition }: Props) {
  const { t } = useI18n();
  const evidence = item.after as OntologyReviewEvidence;
  const original = (item.before as { definition: PaidOrdersDefinition }).definition;
  const proof = evidence.verification;
  const [definition, setDefinition] = useState(() => proof?.definition ?? original);
  const [basis, setBasis] = useState(() => proof?.basis ?? "");
  const current = snapshot?.id === evidence.snapshotId;
  const sameVerification = proof && proof.basis === basis.trim()
    && definitionKey(proof.definition) === definitionKey(definition);
  const proofMatches = proof?.passed && sameVerification;

  return <div className="ontology-review">
    <div className="ontology-notice" data-tone="warning">
      <ActionIcon name="warning" />
      <div>
        <h4>{t(evidence.sourceChangeId ? "ontology.sourceChanged" : "ontology.impact")}</h4>
        {evidence.impacts.length ? <ul>{evidence.impacts.map(({ field, reason }) => <li key={field.role}>
          {t(`ontology.${field.role}`)} · <code>{field.table.schema}.{field.table.name}.{field.column}</code> · {t(`ontology.${reason}`)}
        </li>)}</ul> : null}
      </div>
    </div>
    {evidence.sample ? <>
      {!proof ? <section className="ontology-review-baseline" aria-label={t("ontology.sample")}>
        <h4><ActionIcon name="shield" />{t("ontology.sample")}</h4>
        <dl className="ontology-summary">
          <dt>{t("ontology.sampleMonth")}</dt><dd>{evidence.sample.month} · {original.timeZone}</dd>
          <dt>{t("ontology.expectedOrders")}</dt><dd><code>{evidence.sample.expectedOrderIds.join(", ") || t("ontology.emptySet")}</code></dd>
        </dl>
      </section> : null}
      {current && snapshot ? <DefinitionEditor snapshot={snapshot} definition={definition} disabled={busy} lockTimeZone title={t("ontology.review")}
        submitLabel={t("ontology.runSample")} submitDisabled={!basis.trim()} submitVariant={proofMatches ? "secondary" : "primary"} onChange={setDefinition}
        onConfirm={() => onVerify(definition, basis)}>
        <label className="ontology-review-basis">{t("ontology.basis")}<textarea required rows={3} maxLength={2000} value={basis} placeholder={t("ontology.basisPlaceholder")}
          disabled={busy} onChange={(event) => setBasis(event.target.value)} /></label>
      </DefinitionEditor> : <p className="ontology-feedback">{t("ontology.reviewSnapshotRequired")}</p>}
      <OntologyReviewResult item={item} />
      {proof && current && !sameVerification ? <p className="ontology-feedback ontology-review-rerun">{t("ontology.reviewRerun")}</p> : null}
      {proof ? <div className="ontology-actions">
        <Button variant={proofMatches ? "primary" : "secondary"} disabled={busy || !current || !proofMatches} onClick={() => onClose(proof.id)}>
          {t("ontology.closeReview")}
        </Button>
      </div> : null}
    </> : <div className="ontology-notice" data-tone="neutral">
      <ActionIcon name="info" /><p>{t("ontology.sampleRequired")}</p>
      {onOpenDefinition ? <Button disabled={busy} onClick={() => onOpenDefinition(evidence.definitionId)}>{t("ontology.configureSample")}</Button> : null}
    </div>}
  </div>;
}

function definitionKey(definition: PaidOrdersDefinition) {
  const { name, order, payment } = definition;
  return JSON.stringify([
    name.trim(), order.name.trim(), payment.name.trim(), ontologySelectionKey(definition),
  ]);
}

export function OntologyReviewResult({ item }: { item: ChangeReviewItem }) {
  const { t, formatDate } = useI18n();
  const evidence = item.after as OntologyReviewEvidence;
  const proof = evidence.verification;
  if (!proof) return null;
  const names = (ids: string[]) => ids.join(", ") || t("ontology.emptySet");
  const original = (item.before as { definition: PaidOrdersDefinition }).definition.payment;
  const candidate = proof.definition.payment;

  return <section className="ontology-review-result" aria-label={t("ontology.sample")}>
    <div className="ontology-result-heading" data-tone={proof.passed ? "positive" : "warning"} role={proof.passed ? "status" : "alert"}>
      <ActionIcon name={proof.passed ? "check" : "warning"} />
      <div><strong>{proof.error ?? t(proof.passed ? "ontology.samplePassed" : "ontology.sampleFailed")}</strong>
        <p>{proof.month} · {proof.definition.timeZone}</p></div>
    </div>
    <dl className="ontology-order-comparison">
      <div><dt>{t("ontology.expectedOrders")}</dt><dd><code>{names(proof.expectedOrderIds)}</code></dd></div>
      {proof.error ? null : <>
        <div><dt>{t("ontology.actualOrders")}</dt><dd><code>{names(proof.actualOrderIds)}</code></dd></div>
        <div data-difference={proof.missingOrderIds.length > 0 || undefined}><dt>{t("ontology.missingOrders")}</dt><dd><code>{names(proof.missingOrderIds)}</code></dd></div>
        <div data-difference={proof.unexpectedOrderIds.length > 0 || undefined}><dt>{t("ontology.unexpectedOrders")}</dt><dd><code>{names(proof.unexpectedOrderIds)}</code></dd></div>
      </>}
    </dl>
    <dl className="ontology-summary ontology-result-evidence">
      <dt>{t("ontology.beforeBinding")}</dt><dd><code>{original.table.schema}.{original.table.name}.{original.paidAtColumn}</code></dd>
      <dt>{t("ontology.checkedBinding")}</dt><dd><code>{candidate.table.schema}.{candidate.table.name}.{candidate.paidAtColumn}</code></dd>
      <dt>{t("ontology.basis")}</dt><dd>{proof.basis}</dd>
      <dt>{t("ontology.verifiedAt")}</dt><dd>{formatDate(proof.checkedAt)}</dd>
      {evidence.confirmedRevision ? <><dt>{t("ontology.verifiedVersion")}</dt><dd>{evidence.confirmedRevision}</dd></> : null}
    </dl>
  </section>;
}
