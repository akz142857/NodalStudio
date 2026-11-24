import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../design-system/Button";
import { ModalSurface } from "../design-system/ModalSurface";
import { useI18n } from "../i18n";
import { ActionIcon } from "./ActionIcon";

export function TableDataFooter({ actions, statement, reserveStatementSpace, children }: {
  actions?: ReactNode;
  statement?: { sql: string; preview?: string; sqlite?: boolean };
  reserveStatementSpace?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const bar = useRef<HTMLElement>(null);
  const [inspected, setInspected] = useState<typeof statement>();
  const sqlLabel = t("tableData.currentSql");
  const close = () => setInspected(undefined);

  useLayoutEffect(() => {
    const footer = bar.current;
    const workspace = footer?.closest<HTMLElement>(".canvas-placeholder");
    if (!footer || !workspace || typeof ResizeObserver === "undefined") return;
    const update = () => {
      // Other SQLite table editors stay mounted and report zero while hidden.
      const height = footer.offsetHeight;
      if (height) workspace.style.setProperty("--table-data-footer-measured", `${height}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  return <footer ref={bar} className="table-data-footer" aria-label={t("tableData.footer")}>
    {actions && <div className="table-data-footer-actions" role="group" aria-label={t("tableData.footerActions")}>{actions}</div>}
    {(statement || reserveStatementSpace) && <Button variant="ghost" className="table-data-footer-sql" aria-label={sqlLabel}
      disabled={!statement} style={statement ? undefined : { visibility: "hidden" }}
      aria-haspopup="dialog" title={sqlLabel} onClick={() => setInspected(statement)}>
      <ActionIcon name="viewer" />
      <code>{statement?.preview ?? statement?.sql}</code>
    </Button>}
    {children}
    {inspected && <ModalSurface label={sqlLabel} onDismiss={close}>
      <div className="table-data-statement-backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
        <section className="table-data-statement ds-surface">
          <header><h3>{sqlLabel}</h3><Button variant="ghost" onClick={close}>{t("business.close")}</Button></header>
          {inspected.sqlite && <p>{t("tableData.sqliteSqlParameters")}</p>}
          <pre tabIndex={0} data-modal-focus><code>{inspected.sql}</code></pre>
        </section>
      </div>
    </ModalSurface>}
  </footer>;
}
