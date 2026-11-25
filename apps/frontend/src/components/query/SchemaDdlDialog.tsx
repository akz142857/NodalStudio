import { useEffect, useId, useRef } from "react";
import { useI18n } from "../../i18n";
import { ddlEngineNames, type SchemaDdlInput } from "../../platform/schema-ddl";
import { Button } from "../../design-system/Button";
import { ActionIcon } from "../ActionIcon";

export function SchemaDdlDialog({ request, onConfirm, onCancel }: {
  request: SchemaDdlInput;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const title = useId();
  const description = useId();
  const statement = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const target = request.databaseType === "sqlite" ? request.filePath
    : `${request.username}@${request.host.includes(":") ? `[${request.host}]` : request.host}:${request.port} / ${request.database}`;
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog ref={dialog} className="query-ddl-dialog ds-surface" aria-labelledby={title} aria-describedby={description}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <header className="query-ddl-header">
        <span><ActionIcon name="warning" /></span>
        <div>
          <h3 id={title}>{t("schemaDdl.confirmTitle", { value0: ddlEngineNames[request.databaseType] })}</h3>
          <p id={description}>{t("schemaDdl.confirmDescription")}{request.databaseType === "mySql" && <> {t("schemaDdl.mySqlCommit")}</>}</p>
        </div>
      </header>
      <dl className="query-ddl-target"><dt>{t(request.databaseType === "sqlite" ? "schemaDdl.file" : "schemaDdl.database")}</dt><dd><code>{target}</code></dd></dl>
      <figure className="query-ddl-statement">
        <figcaption id={statement}>{t("schemaDdl.statement")}</figcaption>
        <pre tabIndex={0} aria-labelledby={statement}>{request.sql}</pre>
      </figure>
      <footer>
        <Button ref={cancel} onClick={onCancel}>{t("business.cancel")}</Button>
        <Button variant="primary" onClick={onConfirm}>{t("schemaDdl.apply")}</Button>
      </footer>
    </dialog>
  );
}
