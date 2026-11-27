import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodalStudioPlatform } from "../../platform";
import { codeViewQueryKey } from "../../platform/code-view";
import type { DefinitionRevision } from "../../platform/ontology-types";
import { useI18n } from "../../i18n";
import "./code-view.css";
import { ModalSurface } from "../../design-system/ModalSurface";

export function ProjectSqlSave({ platform, sourceId, sql, generatedFrom, disabled, onOpen }: {
  platform: NodalStudioPlatform;
  sourceId: string;
  sql: string;
  generatedFrom?: DefinitionRevision;
  disabled: boolean;
  onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  const api = platform.codeView!;
  const client = useQueryClient();
  const queryKey = codeViewQueryKey(sourceId);
  const binding = useQuery({
    queryKey: [...queryKey, "query-project"],
    queryFn: () => api.get({ sourceId }),
    networkMode: "always",
    retry: false,
  });
  const [preview, setPreview] = useState<{ path: string; sql: string; generatedFrom?: DefinitionRevision; bindingId: string }>();
  const [saved, setSaved] = useState<{ path: string; bindingId: string; generatedFrom?: DefinitionRevision; associationSaved: boolean | null }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const project = binding.data?.project;

  async function save() {
    if (!preview || saving) return;
    setSaving(true);
    setError("");
    try {
      const path = preview.path.trim();
      const result = await api.save({ sourceId, bindingId: preview.bindingId, path, sql: preview.sql, generatedFrom: preview.generatedFrom });
      setPreview(undefined);
      setSaved({ path, bindingId: preview.bindingId, generatedFrom: preview.generatedFrom, associationSaved: result.associationSaved });
      await client.invalidateQueries({ queryKey });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function retryAssociation() {
    if (!saved?.generatedFrom || !api.retryAssociation || saving) return;
    setSaving(true);
    setError("");
    try {
      await api.retryAssociation({ sourceId, path: saved.path, bindingId: saved.bindingId, generatedFrom: saved.generatedFrom });
      setSaved({ ...saved, associationSaved: true });
      await client.invalidateQueries({ queryKey });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return <>
    {project && <button type="button" className="query-editor-action" disabled={disabled || !sql.trim() || saving} onClick={() => {
      const directory = project.directories[0];
      setPreview({ path: directory ? `${directory}/` : "", sql, generatedFrom, bindingId: project.id });
      setError("");
      setSaved(undefined);
    }}>{t("codeView.saveSql")}</button>}
    {saved && <span className="code-view-save-receipt" role="status">
      {t(saved.associationSaved === false ? "codeView.associationFailed" : "codeView.saveDone")}
      {saved.associationSaved === false && api.retryAssociation && <button type="button" disabled={saving} onClick={() => void retryAssociation()}>{t("codeView.retryAssociation")}</button>}
      {error && !preview && <span role="alert">{error}</span>}
      <button type="button" onClick={() => onOpen(saved.path)}>{t("codeView.title")}</button>
    </span>}
    {preview && <ModalSurface label={t("codeView.saveSql")} onDismiss={() => { if (!saving) setPreview(undefined); }}>
      <div className="query-dialog-backdrop"><form className="query-dialog ds-surface" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h3>{t("codeView.saveSql")}</h3><p>{t("codeView.saveHelp")}</p>
        <label>{t("codeView.path")}<input data-modal-focus value={preview.path} disabled={saving} placeholder="queries/report.sql"
          onChange={(event) => setPreview({ ...preview, path: event.target.value })} /></label>
        <pre className="code-view-save-preview">{preview.sql}</pre>
        {error && <p role="alert">{error}</p>}
        <div className="code-view-actions">
          <button type="button" disabled={saving} onClick={() => setPreview(undefined)}>{t("business.cancel")}</button>
          <button type="submit" className="ds-primary" disabled={saving || !preview.path.trim()}>{t("savedQueries.saveAction")}</button>
        </div>
      </form></div>
    </ModalSurface>}
  </>;
}
