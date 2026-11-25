import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../design-system/Button";
import { ModalSurface } from "../design-system/ModalSurface";
import { useI18n } from "../i18n";
import { translateConnectionFailure } from "../i18n/connection-errors";
import type { CaptureSnapshotResult, DataSourceProfile, NodalStudioPlatform } from "../platform";
import { ActionIcon } from "./ActionIcon";
import { connectionFailure } from "./connection-test-state";

type Catalog =
  | { state: "loading" }
  | { state: "ready"; databases: string[] }
  | { state: "error"; failure: ReturnType<typeof connectionFailure> };

const mysqlSystemDatabases = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

export function DatabaseServerBrowser({ server, platform, startCreating = false, onOpenStart, onOpen, onClose }: {
  server: DataSourceProfile;
  platform: NodalStudioPlatform;
  startCreating?: boolean;
  onOpenStart?: () => void;
  onOpen: (profile: DataSourceProfile, capture: CaptureSnapshotResult) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const heading = useId();
  const description = useId();
  const nameHint = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const catalogView = useRef<HTMLDivElement>(null);
  const catalogScroll = useRef(0);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pending = useRef(false);
  const [catalog, setCatalog] = useState<Catalog>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string>();
  const [draft, setDraft] = useState<string | undefined>(startCreating ? "" : undefined);
  const [activity, setActivity] = useState<{ action: "creating" | "opening"; database: string }>();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<string>();
  const address = server.host.includes(":") && !server.host.startsWith("[")
    ? `[${server.host}]:${server.port}` : `${server.host}:${server.port}`;
  const creating = draft !== undefined;
  const busy = activity !== undefined;
  const loading = catalog.state === "loading";
  const postgres = server.databaseType === "postgreSql";
  const databases = catalog.state === "ready" ? catalog.databases : [];
  const search = query.trim().toLowerCase();
  const visible = search ? databases.filter((name) => name.toLowerCase().includes(search)) : databases;
  const selected = selection !== undefined && visible.includes(selection) ? selection : undefined;
  const emptyMessage = search ? t("serverConnection.noSearchResults") : t("serverConnection.noDatabases");
  const onlySystemDatabases = databases.every((name) => postgres ? name === "postgres" : mysqlSystemDatabases.has(name));

  useEffect(() => {
    let current = true;
    void platform.listServerDatabases(server.id).then(
      (databases) => { if (current) setCatalog({ state: "ready", databases }); },
      (reason: unknown) => { if (current) setCatalog({ state: "error", failure: connectionFailure(reason) }); },
    );
    return () => { current = false; };
  }, [platform, reload, server.id]);

  useEffect(() => {
    if (!busy) (creating ? nameInput : searchInput).current?.focus({ preventScroll: true });
  }, [creating, busy]);

  useLayoutEffect(() => {
    if (!creating && catalogView.current) catalogView.current.scrollTop = catalogScroll.current;
  }, [creating]);

  async function submit(database: string, create: boolean) {
    if (pending.current) return;
    pending.current = true;
    setError(undefined);
    setCreated(undefined);
    setActivity({ action: create ? "creating" : "opening", database });
    let createdDatabase: string | undefined;
    try {
      if (create) {
        createdDatabase = await platform.createServerDatabase(server.id, database, server.updatedAt);
        database = createdDatabase;
        setActivity({ action: "opening", database });
      }
      onOpenStart?.();
      const { profile, capture } = await (create
        ? platform.openServerDatabase(server.id, database, server.updatedAt, true)
        : platform.openServerDatabase(server.id, database, server.updatedAt));
      onOpen(profile, capture);
    } catch (reason) {
      if (createdDatabase !== undefined) {
        const name = createdDatabase;
        setCreated(name);
        setCatalog({ state: "ready", databases: [name, ...databases.filter((item) => item !== name)] });
        setSelection(name);
        setQuery("");
        catalogScroll.current = 0;
        setDraft(undefined);
      }
      setError(translateConnectionFailure(connectionFailure(reason), t));
    } finally {
      pending.current = false;
      setActivity(undefined);
    }
  }

  function focusRow(name: string | undefined) {
    if (name === undefined || busy) return;
    setSelection(name);
    setError(undefined);
    rowRefs.current.get(name)?.focus();
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const name = visible[index];
    switch (event.key) {
      case "ArrowDown": focusRow(visible[Math.min(index + 1, visible.length - 1)]); break;
      case "ArrowUp": focusRow(visible[Math.max(index - 1, 0)]); break;
      case "Home": focusRow(visible[0]); break;
      case "End": focusRow(visible.at(-1)); break;
      case "Enter": void submit(name, false); break;
      default: return;
    }
    event.preventDefault();
  }

  function refresh() {
    setError(undefined);
    setCreated(undefined);
    setCatalog({ state: "loading" });
    setReload((current) => current + 1);
  }

  function back() {
    setDraft(undefined);
    setError(undefined);
  }

  function dismiss() {
    if (pending.current) return;
    if (creating) back();
    else onClose();
  }

  return <ModalSurface labelledBy={heading} describedBy={description} onDismiss={dismiss}>
    <div className="connection-dialog-backdrop" role="presentation">
      <section className="ds-surface database-server-browser">
        <header className="database-server-header">
          <h2 id={heading}>{t(creating ? "serverConnection.createTitle" : "serverConnection.openTitle")}</h2>
          <p id={description}>
            <strong>{server.displayName}</strong>
            <span>{postgres ? "PostgreSQL" : "MySQL"} · {address}{server.security?.ssh ? " · SSH" : null}</span>
          </p>
        </header>
        <form onSubmit={(event) => {
          event.preventDefault();
          const database = creating ? draft.trim() : selected;
          if (database) void submit(database, creating);
        }}>
          <div className={`database-server-content${creating ? " is-creating" : ""}`}>
            {creating ? <div className="database-server-create">
              <label className="database-server-name">
                {t("serverConnection.databaseName")}
                <input ref={nameInput} autoComplete="off" value={draft} aria-describedby={nameHint} disabled={busy}
                  onChange={(event) => { setDraft(event.currentTarget.value); setError(undefined); }} />
              </label>
              <p id={nameHint}>{t(postgres ? "serverConnection.postgresDefaults" : "serverConnection.mysqlDefaults")}</p>
            </div> : <>
              <div className="database-server-tools">
                <div className="database-server-search">
                  <ActionIcon name="search" />
                  <input ref={searchInput} data-modal-focus type="search" autoComplete="off"
                    aria-label={t("serverConnection.search")} placeholder={t("serverConnection.search")} value={query} disabled={busy}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.key !== "ArrowDown" || !visible.length) return;
                      event.preventDefault();
                      focusRow(selected ?? visible[0]);
                    }} />
                </div>
                <Button className="database-server-refresh" aria-label={t("serverConnection.refresh")} title={t("serverConnection.refresh")}
                  disabled={busy || loading} onClick={refresh}><ActionIcon name="refresh" /></Button>
              </div>
              <div ref={catalogView} className="database-server-catalog" aria-busy={loading}>
                {loading && <p className="database-server-empty" role="status">{t("serverConnection.loading")}</p>}
                {catalog.state === "error" && <p role="alert" className="database-server-empty database-server-error">
                  {translateConnectionFailure(catalog.failure, t)}
                </p>}
                {catalog.state === "ready" && (visible.length ? <>
                  {!search && onlySystemDatabases && <p className="database-server-note">{t("serverConnection.noDatabases")}</p>}
                  <ul className="database-server-databases" role="listbox" aria-label={t("business.databases")}>
                    {visible.map((name, index) => <li role="presentation" key={name}>
                      <button type="button" role="option" aria-selected={selected === name} disabled={busy}
                        className="database-server-row" tabIndex={name === (selected ?? visible[0]) ? 0 : -1}
                        ref={(element) => {
                          if (element) rowRefs.current.set(name, element);
                          else rowRefs.current.delete(name);
                        }}
                        onClick={() => { setSelection(name); setError(undefined); }}
                        onDoubleClick={() => void submit(name, false)}
                        onKeyDown={(event) => onRowKeyDown(event, index)}>
                        <ActionIcon name="database" />
                        <span>{name}</span>
                        {selected === name && <ActionIcon name="check" />}
                      </button>
                    </li>)}
                  </ul>
                </> : <p className="database-server-empty" role="status">{emptyMessage}</p>)}
              </div>
            </>}
          </div>
          {(activity || created || error) && <div className="database-server-feedback">
            {activity && <p role="status">{t(activity.action === "creating" ? "serverConnection.creating" : "serverConnection.opening", { database: activity.database })}</p>}
            {created && <p role="status">{t("serverConnection.created", { database: created })}</p>}
            {error && <p role="alert" className="database-server-error">{error}</p>}
          </div>}
          <footer>
            {creating ? <Button variant="ghost" disabled={busy} onClick={back}>
              <ActionIcon name="chevronLeft" />{t("business.back")}
            </Button> : <Button variant="ghost" disabled={busy || loading} onClick={() => {
              catalogScroll.current = catalogView.current?.scrollTop ?? 0;
              setError(undefined);
              setCreated(undefined);
              setDraft("");
            }}>
              <ActionIcon name="add" />{t("serverConnection.newDatabase")}
            </Button>}
            <div className="database-server-actions">
              <Button disabled={busy} onClick={onClose}>{t("business.cancel")}</Button>
              <Button type="submit" variant="primary" disabled={busy || (creating ? !draft.trim() : selected === undefined)}>
                {t(creating ? "serverConnection.createAndOpen" : "serverConnection.open")}
              </Button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  </ModalSurface>;
}
