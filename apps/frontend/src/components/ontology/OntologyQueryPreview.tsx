import { useI18n } from "../../i18n";
import type { OntologyQueryDraft } from "../../platform/ontology-types";
import { ActionIcon } from "../ActionIcon";
import "./ontology.css";

export function OntologyQueryPreview({ draft }: { draft: OntologyQueryDraft }) {
  const { t } = useI18n();
  return <div className="ontology-sql-preview">
    <div className="ontology-sql-context">
      <ActionIcon name="history" />
      <p>{t("ontology.queryContext", {
        value0: draft.definitionName, value1: draft.revision, value2: draft.startsAt,
        value3: draft.endsBefore, value4: draft.timeZone,
      })}</p>
    </div>
    <pre tabIndex={0} aria-label={t("business.sQLToInsert")}>{draft.sql}</pre>
  </div>;
}
