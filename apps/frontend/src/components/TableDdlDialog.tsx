import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ModalSurface } from "../design-system/ModalSurface";
import { useI18n } from "../i18n";
import type { DataSourceProfile, NodalStudioPlatform, TableDefinition } from "../platform/types";
import { DefinitionReader } from "./ObjectDocument";

export function TableDdlDialog({ platform, profile, table, onClose }: {
  platform: NodalStudioPlatform;
  profile: DataSourceProfile;
  table: TableDefinition;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const nameId = useId();
  const [copyFailed, setCopyFailed] = useState(false);
  const { schema, name } = table.key;
  const definition = useQuery({
    queryKey: ["table-ddl", profile.id, profile.updatedAt, schema, name],
    queryFn: () => platform.readTableDdl({ sourceId: profile.id, connectionRevision: profile.updatedAt, schema, name }),
    networkMode: "always",
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const sql = definition.data;
  async function copyDdl() {
    if (!sql) return;
    try {
      await navigator.clipboard.writeText(sql);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return <ModalSurface labelledBy={titleId} describedBy={nameId} onDismiss={onClose}>
    <div className="table-data-statement-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="table-data-statement table-ddl-dialog ds-surface">
        <header>
          <div className="table-ddl-heading">
            <h2 id={titleId}>{t("tableDdl.title")}</h2>
            <p id={nameId} title={`${schema}.${name}`}>{schema}.{name}</p>
          </div>
          <div className="table-ddl-actions">
            <button type="button" disabled={!sql || definition.isError} onClick={() => void copyDdl()}>{t("tableDdl.copy")}</button>
            <button type="button" data-modal-focus onClick={onClose}>{t("business.close")}</button>
          </div>
        </header>
        {copyFailed && <p className="table-ddl-note" role="alert">{t("document.copyFailed")}</p>}
        {definition.isError ? <div className="table-ddl-feedback">
          <p role="alert">{t("tableDdl.failed")}</p>
          <button type="button" disabled={definition.isFetching} onClick={() => void definition.refetch()}>{t("tableData.retry")}</button>
        </div> : sql ? <>
          {profile.databaseType === "postgreSql" && <p className="table-ddl-note">{t("tableDdl.postgresCatalog")}</p>}
          <DefinitionReader value={sql} wrap={false} dialect={profile.databaseType} />
        </> : <div className="table-ddl-feedback"><p role="status">{t("tableDdl.loading")}</p></div>}
      </section>
    </div>
  </ModalSurface>;
}
