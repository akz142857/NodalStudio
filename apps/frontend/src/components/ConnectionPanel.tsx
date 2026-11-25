import { useI18n } from "../i18n";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { ConnectionTestStatus } from "./ConnectionTestStatus";
import { connectionFailure, type ConnectionTestState } from "./connection-test-state";
import { ConnectionSecurityFields } from "./ConnectionSecurityFields";
import { ConnectionManager } from "./ConnectionManager";
import { SchemaObjectMenu } from "./SchemaObjectMenu";
import { DataSourcePicker } from "./DataSourcePicker";
import { DatabaseServerBrowser } from "./DatabaseServerBrowser";
import { SearchSelect } from "./SearchSelect";
import { isServerConnection, isServerConnectionForm, lastServerDatabase, rememberServerDatabase } from "../platform/database-server";
import { translateConnectionFailure } from "../i18n/connection-errors";
import { ConnectionSourceContext } from "./connection-source-context";
import { ActionIcon } from "./ActionIcon";
import { Button } from "../design-system/Button";
import { ModalSurface } from "../design-system/ModalSurface";
import "./model-navigation.css";
import type {
  ConnectionSecurity,
  DataSourceProfile,
  CaptureSnapshotResult,
  NodalStudioPlatform,
  SaveDataSourceInput,
  SslMode,
} from "../platform";

interface ConnectionPanelProps {
  enabled: boolean;
  /** The source whose snapshot is on the canvas; its objects nest beneath it. */
  activeSourceId?: string;
  initializingDatabase?: boolean;
  /** Reload profiles after imports or settings mutations outside this panel. */
  sourcesRevision?: number;
  /** The schema tree rendered below the active source's picker. */
  children?: ReactNode;
  platform: NodalStudioPlatform;
  onSnapshot: (result: CaptureSnapshotResult) => void;
  onOpenDatabase?: (result: CaptureSnapshotResult) => void;
  onDatabaseCleared?: () => void;
  onSourceSaved?: (source: DataSourceProfile) => void;
  onSourceOpenStart?: () => void;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  onSourceDeleted?: (sourceId: string) => void;
  defaultDatabaseType: SaveDataSourceInput["databaseType"];
  defaultSslMode: SslMode;
}

const initialForm: SaveDataSourceInput = {
  displayName: "Local development",
  host: "127.0.0.1",
  port: 5432,
  database: "postgres",
  username: "postgres",
  password: "",
  databaseType: "postgreSql",
  sslMode: "disable",
};

class MissingSchemaSnapshotError extends Error {}

type DatabaseCatalogResult = { state: "ready"; databases: string[] } | { state: "error"; failure: ReturnType<typeof connectionFailure> };
type DatabaseCatalog = { serverKey: string } & ({ state: "loading" } | DatabaseCatalogResult);

const serverKey = (server: DataSourceProfile) => JSON.stringify([server.id, server.updatedAt]);

function newConnectionForm(
  databaseType: SaveDataSourceInput["databaseType"],
  sslMode: SslMode,
  displayName: string,
): SaveDataSourceInput {
  return {
    ...initialForm,
    displayName,
    databaseType,
    database: databaseType === "mySql" ? "" : initialForm.database,
    port: databaseType === "mySql" ? 3306 : 5432,
    sslMode,
  };
}



function connectionDetailsDiffer(
  profile: DataSourceProfile,
  form: SaveDataSourceInput,
): boolean {
  return (
    profile.databaseType !== form.databaseType ||
    JSON.stringify(profile.sqlite ?? null) !== JSON.stringify(form.sqlite ?? null) ||
    profile.host.trim() !== form.host.trim() ||
    profile.port !== form.port ||
    profile.database.trim() !== form.database.trim() ||
    profile.username.trim() !== form.username.trim() ||
    profile.sslMode !== form.sslMode ||
    JSON.stringify(profile.security ?? { tls: {} }) !== JSON.stringify(form.security ?? { tls: {} })
  );
}

export function ConnectionPanel({ enabled, activeSourceId, initializingDatabase, sourcesRevision, children, platform, onSnapshot, onOpenDatabase, onDatabaseCleared, onSourceSaved, onSourceOpenStart, onSourceDeleted, onRefresh, refreshDisabled, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
  const { t: bt } = useI18n();
  const sslModeDescriptions: Record<SslMode, string> = {
    disable: bt("business.tLSIsDisabledForThisConnection"),
    prefer: bt("business.useTLSWhenAvailableThisModeCanFallBack"),
    require: bt("business.requireEncryptionWithoutVerifyingTheServerIdentity"),
    verifyCa: bt("business.requireTLSAndVerifyTheCertificateAuthority"),
    verifyFull: bt("business.requireTLSAndVerifyTheDatabaseServerIdentity"),
  };
  const navigation = useRef<HTMLElement>(null);
  const [managerOpen, setManagerOpen] = useState<"manage" | "import">();
  const [form, setForm] = useState<SaveDataSourceInput>(() => newConnectionForm(defaultDatabaseType, defaultSslMode, bt("business.localDevelopment")));
  const [profiles, setProfiles] = useState<DataSourceProfile[]>([]);
  const testController = useRef<AbortController | null>(null);
  const newSourceId = useRef<string | undefined>(undefined);
  useEffect(() => () => { testController.current?.abort(); testController.current = null; }, []);
  const [testState, setTestState] = useState<ConnectionTestState>({ status: "idle" });
  const [error, setError] = useState<string>();
  const openContext = useMemo(() => ({ sourceId: activeSourceId }), [activeSourceId]);
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement; context: typeof openContext }>();
  const [openError, setOpenError] = useState<{
    context: typeof openContext;
    profile: DataSourceProfile;
    message: string;
    missingSnapshot: boolean;
  }>();
  const [pending, setPending] = useState(false);
  const [connectionTab, setConnectionTab] = useState<"general" | "tls" | "ssh">("general");
  const dialogBody = useRef<HTMLDivElement>(null);
  useEffect(() => { if (dialogBody.current) dialogBody.current.scrollTop = 0; }, [connectionTab]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DataSourceProfile>();
  const [serverBrowser, setServerBrowser] = useState<DataSourceProfile>();
  const [selectedServer, setSelectedServer] = useState<{ id: string; previousSourceId?: string }>();
  const [databaseCatalog, setDatabaseCatalog] = useState<DatabaseCatalog>();
  const [databaseError, setDatabaseError] = useState<{ context: typeof openContext; database: string; message: string }>();
  const [pendingDatabase, setPendingDatabase] = useState<{ connection: DataSourceProfile; database: string }>();
  const databaseStatusId = useId();
  const databaseRequest = useRef<{ serverKey: string; result: Promise<DatabaseCatalogResult> }>(undefined);
  const openingDatabase = useRef(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    profile: DataSourceProfile;
    resolve: (confirmed: boolean) => void;
  }>();
  const pendingLocalSetup = editingProfile?.connectionSync?.pending === true;
  const serverForm = isServerConnectionForm(form);
  const editingServer = editingProfile ? isServerConnection(editingProfile) : false;
  const databaseOptional = form.databaseType !== "sqlite" && (!editingProfile || editingServer);
  const invalidScope = serverForm && !databaseOptional;
  const canRequireTls = form.databaseType !== "sqlite" && (form.sslMode === "disable" || form.sslMode === "prefer");
  const tlsGuidance = form.sslMode === "disable" ? "connectionTls.disabledGuidance"
    : form.sslMode === "prefer" ? "connectionTls.preferredGuidance" : "connectionTls.requiredForThisConnection";
  const unencryptedRejected = testState.status === "error" && testState.failure.code === "unencryptedConnectionRejected";
  const requiresLiveVerification = editingProfile
    ? pendingLocalSetup || connectionDetailsDiffer(editingProfile, form) || Boolean(form.sshPassword || form.sshKeyPassphrase || form.password)
    : false;

  const savedSsh = pendingLocalSetup ? undefined : editingProfile?.security?.ssh;
  const formSsh = form.security?.ssh;
  const hasSavedSshPassword = savedSsh?.authentication === "password" && formSsh?.host === savedSsh.host
    && formSsh?.port === savedSsh.port && formSsh?.username === savedSsh.username;

  const serverProfiles = profiles.filter(isServerConnection);
  const connections = profiles.filter((profile) => !serverProfiles.some((server) => server.id === profile.serverSourceId));
  const activeProfile = profiles.find((profile) => profile.id === activeSourceId);
  const parentServer = serverProfiles.find((server) => server.id === activeProfile?.serverSourceId);
  const browsingServer = serverProfiles.find((server) => server.id === selectedServer?.id);
  // A workspace loaded elsewhere takes over the sidebar selection.
  if (selectedServer && activeSourceId && activeSourceId !== selectedServer.previousSourceId) setSelectedServer(undefined);
  const activeConnection = browsingServer ?? parentServer ?? activeProfile;
  const activeServer = activeConnection && isServerConnection(activeConnection) ? activeConnection : undefined;
  const activeDatabase = activeServer
    ? activeProfile?.serverSourceId === activeServer.id ? activeProfile.database : undefined
    : activeConnection?.database;
  const activeServerKey = activeServer && serverKey(activeServer);
  const catalog = databaseCatalog?.serverKey === activeServerKey ? databaseCatalog : undefined;
  const databaseStatus = pendingDatabase
    ? pendingDatabase.connection.id === activeConnection?.id
      ? bt("serverConnection.opening", { database: pendingDatabase.database })
      : bt("serverConnection.openingOn", { database: pendingDatabase.database, connection: pendingDatabase.connection.displayName })
    : initializingDatabase && activeDatabase ? bt("serverConnection.initializing", { database: activeDatabase }) : "";
  const visibleDatabaseError = databaseError?.context === openContext ? databaseError : undefined;
  const databaseOptions = catalog?.state === "ready"
    ? catalog.databases.map((name) => ({ value: name, label: name })) : [];

  useEffect(() => {
    if (parentServer && activeProfile?.database) rememberServerDatabase(parentServer.id, activeProfile.database);
  }, [parentServer, activeProfile?.database]);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void platform
      .listDataSources()
      .then((next) => { if (current) setProfiles(next); })
      .catch((reason: unknown) => {
        if (current) setError(connectionFailure(reason).message);
      });
    return () => { current = false; };
  }, [enabled, platform, sourcesRevision]);

  function updateField<Key extends keyof SaveDataSourceInput>(
    key: Key,
    value: SaveDataSourceInput[Key],
  ) {
    setTestState({ status: "idle" });
    setError(undefined);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateSshSecurity(security: ConnectionSecurity) {
    setTestState({ status: "idle" });
    setError(undefined);
    setForm((current) => {
      const old = current.security?.ssh;
      const next = security.ssh;
      const sameKey = old && next && old.authentication === next.authentication
        && old.host === next.host && old.port === next.port && old.username === next.username
        && old.privateKey === next.privateKey;
      return { ...current, security, sshKeyPassphrase: sameKey ? current.sshKeyPassphrase : "" };
    });
  }

  async function pickSqlite(folder: boolean) {
    if (!enabled || pending) return;
    setPending(true);
    try {
      const path = await platform.pickWorkspacePath(folder ? "sqliteDirectory" : "openSqlite");
      if (!path) return;
      updateField("sqlite", folder ? { path: form.sqlite?.path ?? "", accessDirectory: path } : { path });
    } catch (reason) { setError(connectionFailure(reason).message); }
    finally { setPending(false); }
  }

  async function testConnection(input = form) {
    if (!enabled || pending || invalidScope || testController.current) return;
    const controller = new AbortController();
    testController.current = controller;
    setPending(true);
    setError(undefined);
    setTestState({ status: "testing", progress: { phase: "configuration", sshConnected: false } });
    try {
      const result = await platform.testPostgresConnection(input, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (testController.current === controller && !controller.signal.aborted) setTestState({ status: "testing", progress });
        },
      });
      if (testController.current !== controller) return;
      if (controller.signal.aborted) setTestState((current) => ({ status: "cancelled", progress: current.status === "testing" ? current.progress : undefined }));
      else setTestState({ status: "success", result });
    } catch (reason) {
      if (testController.current !== controller) return;
      const failure = connectionFailure(reason);
      if (failure.code === "passwordRequired") setConnectionTab("general");
      if (controller.signal.aborted || failure.stage === "cancelled") setTestState((current) => ({ status: "cancelled", progress: current.status === "testing" ? current.progress : undefined }));
      else setTestState((current) => ({ status: "error", failure, progress: current.status === "testing" ? current.progress : undefined }));
    } finally {
      if (testController.current === controller) {
        testController.current = null;
        setPending(false);
      }
    }
  }

  function requireTlsAndRetest() {
    if (!canRequireTls || !enabled || pending || invalidScope || testController.current) return;
    const encrypted = { ...form, sslMode: "require" as const };
    setForm(encrypted);
    void testConnection(encrypted);
  }

  function handleTlsGuidance() {
    if (canRequireTls) {
      updateField("sslMode", "require");
      return;
    }
    setConnectionTab("tls");
    document.getElementById("connection-tab-tls")?.focus();
  }

  function cancelConnectionTest() {
    const controller = testController.current;
    if (!controller || controller.signal.aborted) return;
    setTestState((current) => current.status === "testing" ? { ...current, cancelling: true } : current);
    controller.abort();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || pending || invalidScope) return;
    if ((!editingProfile || requiresLiveVerification) && testState.status !== "success") return;
    if (editingProfile && requiresLiveVerification && !serverForm) {
      await verifyAndRefreshEditingSource();
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      if (editingProfile && !serverForm) {
        const profile = await platform.saveDataSource(form);
        onSourceSaved?.(profile);
        setProfiles((current) => [
          profile,
          ...current.filter((item) => item.id !== profile.id),
        ]);
        setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "", sshKeyPassphrase: "" }));
        setEditingProfile(profile);
        setDialogOpen(false);
        return;
      }
      const sourceId = newSourceId.current ??= crypto.randomUUID();
      const mapped = serverForm ? undefined : await platform.saveAndMapDataSource(form, sourceId);
      const profile = mapped?.profile ?? await platform.saveDataSource({ ...form, id: form.id ?? sourceId });
      onSourceSaved?.(profile);
      setProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      if (isServerConnection(profile)) selectServer(profile, requiresLiveVerification);
      else if (mapped) onSnapshot(mapped.capture);
      setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "", sshKeyPassphrase: "" }));
      setDialogOpen(false);
    } catch (reason) {
      if (typeof reason === "object" && reason !== null && "stage" in reason) {
        setTestState({ status: "error", failure: connectionFailure(reason) });
      } else {
        setError(connectionFailure(reason).message);
      }
    } finally {
      setPending(false);
    }
  }

  async function verifyAndRefreshEditingSource() {
    if (!enabled || pending || !editingProfile) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await platform.verifyAndRefreshDataSource(form);
      const profile = result.profile;
      onSourceSaved?.(profile);
      setProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      onSnapshot(result.capture);
      setOpenError((current) => current?.profile.id === profile.id ? undefined : current);
      setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "", sshKeyPassphrase: "" }));
      setEditingProfile(profile);
      setDialogOpen(false);
    } catch (reason) {
      if (typeof reason === "object" && reason !== null && "stage" in reason) {
        setTestState({ status: "error", failure: connectionFailure(reason) });
      } else {
        setTestState({ status: "idle" });
        setError(connectionFailure(reason).message);
      }
    } finally {
      setPending(false);
    }
  }

  async function openSavedSnapshot(profile: DataSourceProfile) {
    const snapshots = await platform.listSnapshots(profile.id);
    const latest = snapshots[0];
    if (!latest) {
      throw new MissingSchemaSnapshotError(bt("business.missingSchemaSnapshot", { value0: bt("business.verifyRefresh") }));
    }
    const snapshot = await platform.getSnapshot(latest.id);
    (onOpenDatabase ?? onSnapshot)({ snapshot, stored: false, changeSet: null });
  }

  function selectServer(server: DataSourceProfile, connectionChanged = false) {
    onSourceOpenStart?.();
    setOpenError(undefined);
    setDatabaseError(undefined);
    setSelectedServer({ id: server.id, previousSourceId: activeSourceId });
    // A change to the server binding requires reopening the database through the server.
    if (connectionChanged || activeProfile?.serverSourceId !== server.id) onDatabaseCleared?.();
  }

  function loadDatabases(server: DataSourceProfile): Promise<DatabaseCatalogResult> {
    const key = serverKey(server);
    if (databaseRequest.current?.serverKey === key) return databaseRequest.current.result;
    setDatabaseCatalog({ serverKey: key, state: "loading" });
    const result = platform.listServerDatabases(server.id).then<DatabaseCatalogResult, DatabaseCatalogResult>(
      (databases) => ({ state: "ready", databases }),
      (reason: unknown) => ({ state: "error", failure: connectionFailure(reason) }),
    ).then((catalog) => {
      if (databaseRequest.current?.result === result) setDatabaseCatalog({ serverKey: key, ...catalog });
      return catalog;
    }).finally(() => {
      if (databaseRequest.current?.result === result) databaseRequest.current = undefined;
    });
    databaseRequest.current = { serverKey: key, result };
    return result;
  }

  function acceptServerDatabase(server: DataSourceProfile, profile: DataSourceProfile, capture: CaptureSnapshotResult) {
    rememberServerDatabase(server.id, profile.database);
    onSourceSaved?.(profile);
    setProfiles((current) => [profile, ...current.filter((source) => source.id !== profile.id)]);
    (onOpenDatabase ?? onSnapshot)(capture);
  }

  async function chooseDatabase(server: DataSourceProfile, database: string, listedFrom?: "remembered" | "manager") {
    if (openingDatabase.current) return;
    openingDatabase.current = true;
    onSourceOpenStart?.();
    setOpenError(undefined);
    setDatabaseError(undefined);
    setPendingDatabase({ connection: server, database });
    setPending(true);
    const showError = (message: string) => setDatabaseError({ context: openContext, database, message });
    try {
      if (listedFrom) {
        const catalog = await loadDatabases(server);
        if (catalog.state === "error") {
          showError(translateConnectionFailure(catalog.failure, bt));
          return;
        }
        if (!catalog.databases.includes(database)) {
          if (listedFrom === "remembered") selectServer(server);
          else showError(bt("serverConnection.databaseUnavailable"));
          return;
        }
      }
      const { profile, capture } = await platform.openServerDatabase(server.id, database, server.updatedAt);
      acceptServerDatabase(server, profile, capture);
    } catch (reason) {
      showError(translateConnectionFailure(connectionFailure(reason), bt));
    } finally {
      openingDatabase.current = false;
      setPendingDatabase(undefined);
      setPending(false);
    }
  }

  async function handleExistingOpen(profile: DataSourceProfile) {
    if (!enabled || pending) return;
    if (profile.connectionSync?.pending) {
      openEditDialog(profile);
      return;
    }
    if (isServerConnection(profile)) {
      if (profile.id === activeServer?.id) return;
      const lastDatabase = lastServerDatabase(profile.id);
      if (lastDatabase) await chooseDatabase(profile, lastDatabase, "remembered");
      else selectServer(profile);
      return;
    }
    const server = serverProfiles.find((source) => source.id === profile.serverSourceId);
    if (server) {
      if (server.connectionSync?.pending) { openEditDialog(server); return; }
      await chooseDatabase(server, profile.database, "manager");
      return;
    }
    onSourceOpenStart?.();
    setPending(true);
    setPendingDatabase({ connection: profile, database: profile.database });
    setError(undefined);
    setOpenError(undefined);
    setDatabaseError(undefined);
    try {
      await openSavedSnapshot(profile);
      setSelectedServer(undefined);
    } catch (reason) {
      setOpenError({
        context: openContext,
        profile,
        message: connectionFailure(reason).message,
        missingSnapshot: reason instanceof MissingSchemaSnapshotError,
      });
    } finally {
      setPendingDatabase(undefined);
      setPending(false);
    }
  }

  function openCreateDialog() {
    newSourceId.current = undefined;
    setForm(newConnectionForm(defaultDatabaseType, defaultSslMode, bt("business.localDevelopment")));
    setEditingProfile(undefined);
    setError(undefined);
    setTestState({ status: "idle" });
    setConnectionTab("general");
    setDialogOpen(true);
  }

  function openEditDialog(profile: DataSourceProfile) {
    setForm({ ...profile, password: "", sshPassword: "", sshKeyPassphrase: "" });
    setEditingProfile(profile);
    setError(undefined);
    setTestState({ status: "idle" });
    setConnectionTab("general");
    setDialogOpen(true);
  }

  function closeDialog() {
    if (pending) return;
    setDialogOpen(false);
    setForm((current) => ({ ...current, password: "", sshPassword: "", sshKeyPassphrase: "" }));
    setError(undefined);
  }

  async function deleteSource(profile: DataSourceProfile) {
    if (!enabled || pending || deleteConfirmation) return false;
    const confirmed = await new Promise<boolean>((resolve) => setDeleteConfirmation({ profile, resolve }));
    if (!confirmed) return false;
    setPending(true);
    setError(undefined);
    try {
      await platform.clearCredentials(profile.id, { database: profile.databaseType !== "sqlite", ai: true, cloud: true });
      await platform.deleteSourceData(profile.id, {
        deleteConnection: true,
        deleteHistory: true,
        deleteSemantics: true,
        removeDatabaseCredential: false,
      });
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setOpenError((current) => current?.profile.id === profile.id ? undefined : current);
      if (profile.id === editingProfile?.id) {
        setDialogOpen(false);
        setEditingProfile(undefined);
      }
      onSourceDeleted?.(profile.id);
      const nextProfile = profiles.find((item) => item.id !== profile.id && !isServerConnection(item));
      if (profile.id === activeSourceId && nextProfile) {
        // Loading the next model is separate from the completed deletion.
        await openSavedSnapshot(nextProfile).catch((reason: unknown) => setError(connectionFailure(reason).message));
      }
      return true;
    } finally {
      setPending(false);
    }
  }

  function finishDeleteConfirmation(confirmed: boolean) {
    setDeleteConfirmation(undefined);
    deleteConfirmation?.resolve(confirmed);
  }

  const visibleMenu = menu?.context === openContext ? menu : undefined;
  const menuProfile = visibleMenu && visibleMenu.trigger !== navigation.current ? activeConnection : undefined;
  // A successful open from another entry point supersedes this attempt, even
  // when its rejection arrives after the workspace has already changed.
  const visibleOpenError = openError?.context === openContext ? openError : undefined;

  function openConnectionMenu(event: MouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) {
    if (dialogOpen || managerOpen || serverBrowser) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    const fromNavigation = trigger === navigation.current;
    setMenu({
      x: pointer ? event.clientX : bounds.left + (fromNavigation ? 12 : 0),
      y: pointer ? event.clientY : fromNavigation ? bounds.top + 40 : bounds.bottom,
      trigger,
      context: openContext,
    });
  }

  return (
    <section ref={navigation} className="connection-stack model-navigation" aria-label={bt("business.dataSources")} tabIndex={0}
      onContextMenu={(event) => {
        if ((event.target as Element).closest('button, input, select, textarea, a, [role="dialog"], [role="menu"], .tree-row')) return;
        openConnectionMenu(event);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
        openConnectionMenu(event);
      }}>
      <header className="source-navigation-heading">
        <h2 id="data-sources-title">{bt("serverConnection.connections")}</h2>
        <button type="button" className="create-connection-button" aria-label={bt("business.addDatabase")} onClick={openCreateDialog} disabled={!enabled || pending}><span aria-hidden="true">＋</span> {bt("business.add")}</button>
      </header>
      {profiles.length > 0 ? <div className="source-navigation-current">
        <DataSourcePicker profiles={connections} activeProfile={activeConnection} disabled={!enabled || pending}
          onSelect={(profile) => { void handleExistingOpen(profile); }}
          onEdit={openEditDialog} onManage={() => setManagerOpen("manage")} onContextMenu={openConnectionMenu} />
      </div> : null}
      {(activeConnection || databaseStatus || visibleDatabaseError) && <div className="source-database-scope ds-surface">
        {activeServer ? <SearchSelect key={activeServerKey} variant="database" label={bt("business.database")} value={activeDatabase ?? ""} options={databaseOptions}
            placeholder={bt("business.selectDatabase")} searchPlaceholder={bt("serverConnection.search")} missingLabel={activeDatabase}
            validateSelection={catalog?.state === "ready"}
            disabled={!enabled || (pending && !pendingDatabase) || activeServer.connectionSync?.pending}
            busy={Boolean(databaseStatus)} loading={!catalog || catalog.state === "loading"} describedBy={databaseStatus ? databaseStatusId : undefined}
            labelAction={<Button variant="ghost" size="small" className="source-database-add" aria-label={bt("serverConnection.newDatabase")} title={bt("serverConnection.newDatabase")}
              disabled={!enabled || pending || Boolean(databaseStatus) || activeServer.connectionSync?.pending} onClick={() => setServerBrowser(activeServer)}><ActionIcon name="add" /></Button>}
            onOpen={() => void loadDatabases(activeServer)}
            emptyMessage={catalog?.state === "error" ? translateConnectionFailure(catalog.failure, bt)
              : catalog?.state !== "ready" ? bt("serverConnection.loading") : bt(databaseOptions.length ? "serverConnection.noSearchResults" : "serverConnection.noDatabases")}
            onChange={(database) => void chooseDatabase(activeServer, database)} /> : activeConnection && <div className="source-database-fixed">
          <span>{bt("business.database")}</span><div className="source-database-fixed-value">
            <ActionIcon name="database" /><p title={activeDatabase}>{activeDatabase}</p>
            {databaseStatus && <span className="search-select-progress" aria-hidden="true" />}
          </div>
        </div>}
        {visibleDatabaseError && <div className="source-database-error" role="alert">
          <strong>{bt("business.couldNotOpenDatabase", { value0: visibleDatabaseError.database })}</strong><p>{visibleDatabaseError.message}</p>
        </div>}
        <p id={databaseStatusId} className={databaseStatus ? "source-database-status" : "visually-hidden"} aria-live="polite" aria-atomic="true">
          {databaseStatus && !activeConnection && <span className="search-select-progress" aria-hidden="true" />}{databaseStatus}
        </p>
      </div>}
      {serverBrowser ? <DatabaseServerBrowser key={serverBrowser.id} server={serverBrowser} platform={platform} startCreating
        onOpenStart={onSourceOpenStart} onClose={() => setServerBrowser(undefined)}
        onOpen={(profile, capture) => {
          acceptServerDatabase(serverBrowser, profile, capture);
          setServerBrowser(undefined);
        }} /> : null}
      {visibleOpenError ? <div className="ds-surface connection-open-error">
        <ActionIcon name="warning" />
        <div className="connection-open-error-content">
          <div role="alert">
            <strong>{bt("business.couldNotOpenDatabase", { value0: visibleOpenError.profile.database })}</strong>
            <p>{visibleOpenError.message}</p>
          </div>
          <Button size="small" disabled={!enabled || pending} onClick={() => {
            if (visibleOpenError.missingSnapshot) openEditDialog(visibleOpenError.profile);
            else void handleExistingOpen(visibleOpenError.profile);
          }}>
            {bt(visibleOpenError.missingSnapshot ? "business.editConnection" : "business.retryOpeningDatabase")}
          </Button>
        </div>
      </div> : null}
      {visibleMenu ? <SchemaObjectMenu x={visibleMenu.x} y={visibleMenu.y}
        name={menuProfile?.displayName ?? bt("serverConnection.connections")}
        actions={[
          { label: bt("business.newConnection"), disabled: !enabled || pending, run: openCreateDialog },
          { label: bt("business.manageConnections"), disabled: !enabled || pending, run: () => setManagerOpen("manage") },
          { label: bt("business.refreshSchema"), separatorBefore: true, disabled: !activeProfile || !onRefresh || refreshDisabled || pending, run: () => onRefresh?.() },
        ]} onClose={(restoreFocus) => {
          setMenu(undefined);
          if (restoreFocus) (visibleMenu.trigger.isConnected ? visibleMenu.trigger : navigation.current)?.focus();
        }} /> : null}
      {managerOpen ? <ConnectionManager profiles={profiles} activeSourceId={activeSourceId} pending={pending} platform={platform}
        startWithImport={managerOpen === "import"} onClose={() => setManagerOpen(undefined)}
        onCreate={() => { setManagerOpen(undefined); openCreateDialog(); }}
        onEdit={(profile) => { setManagerOpen(undefined); openEditDialog(profile); }}
        onOpen={(profile) => { setManagerOpen(undefined); if (profile.id !== activeSourceId) void handleExistingOpen(profile); }}
        onImported={(added) => {
          const ids = new Set(added.map(({ id }) => id));
          setProfiles((current) => [...current.filter(({ id }) => !ids.has(id)), ...added]);
          for (const profile of added) onSourceSaved?.(profile);
        }}
        onDelete={deleteSource} /> : null}
      {profiles.length > 0 ? (
        <div className="saved-sources">
          {activeProfile && (!activeServer || activeDatabase) ? <div key={activeProfile.id}><ConnectionSourceContext.Provider value={activeProfile}>{children}</ConnectionSourceContext.Provider></div> : null}
        </div>
      ) : (<>
        <button type="button" className="empty-data-source" onClick={openCreateDialog} disabled={!enabled}>
          <strong>{bt("business.noDatabaseConnected")}</strong>
          <span>{bt("business.createAConnectionToMapItsSchema")}</span>
        </button>
        {enabled ? <Button className="connection-sync-shortcut" onClick={() => setManagerOpen("import")} disabled={pending}>{bt("connectionSync.open")}</Button> : null}
      </>
      )}

      {!enabled ? <p className="connection-note">{bt("business.installTheDesktopAppToConnectADatabase")}</p> : null}
      {error && !dialogOpen ? <p className="error-message connection-status">{error}</p> : null}

      {deleteConfirmation ? <ModalSurface labelledBy="delete-connection-title" describedBy="delete-connection-detail" onDismiss={() => finishDeleteConfirmation(false)}>
        <div className="connection-confirmation-backdrop">
          <section className="ds-surface connection-confirmation">
            <h2 id="delete-connection-title">{bt("business.deleteConnectionConfirmation", { value0: deleteConfirmation.profile.displayName })}</h2>
            <p id="delete-connection-detail">{bt("business.deleteConnectionImpact")}</p>
            <footer>
              <Button data-modal-focus onClick={() => finishDeleteConfirmation(false)}>{bt("business.cancel")}</Button>
              <Button variant="danger" onClick={() => finishDeleteConfirmation(true)}>{bt("businessMeta.delete")}</Button>
            </footer>
          </section>
        </div>
      </ModalSurface> : null}

      {dialogOpen ? (
        <ModalSurface labelledBy="connection-dialog-title" describedBy="connection-dialog-description" onDismiss={closeDialog}>
        <div className="connection-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <section className="connection-dialog">
            <header>
              <div>
                <h2 id="connection-dialog-title">
                  {editingProfile ? bt("business.edit", { value0: editingProfile.displayName }) : bt("business.createDatabaseConnection")}
                </h2>
              </div>
              <button type="button" className="dialog-close-button" aria-label={bt("business.closeConnectionDialog")} onClick={closeDialog} disabled={pending}>×</button>
            </header>
            <p id="connection-dialog-description" className="dialog-description">
              {form.databaseType === "sqlite" ? bt("sqlite.readonly") : editingProfile
                ? bt("business.testConnectionChangesBeforeSavingExistingPasswordsAreReused")
                : bt(serverForm ? "serverConnection.connectionDescription" : "business.addADatabaseVerifyAccessAndCreateItsFirst")}
            </p>
            <form className="connection-panel" onSubmit={(event) => void handleSubmit(event)}>
              {form.databaseType !== "sqlite" ? <div className="connection-tabs" role="tablist" aria-label={bt("business.connectionSettings")}>
                {([['general', bt("business.connection")], ['tls', 'TLS'], ['ssh', 'SSH']] as const).filter(([tab]) => form.databaseType !== 'sqlite' || tab === 'general').map(([tab, label]) => <button key={tab} type="button" role="tab" id={`connection-tab-${tab}`} aria-controls={`connection-panel-${tab}`} aria-selected={connectionTab === tab} tabIndex={connectionTab === tab ? 0 : -1} onClick={() => setConnectionTab(tab)} onKeyDown={(event) => {
                  const tabs: ("general" | "tls" | "ssh")[] = form.databaseType === "sqlite" ? ["general"] : ["general", "tls", "ssh"];
                  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
                  event.preventDefault();
                  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + direction + tabs.length) % tabs.length;
                  setConnectionTab(tabs[index]);
                  document.getElementById(`connection-tab-${tabs[index]}`)?.focus();
                }}>{label}{tab === 'ssh' && form.security?.ssh ? <span className="connection-tab-dot" aria-label={bt("business.enabled")} /> : null}</button>)}
              </div> : null}
              <div className="connection-dialog-body" ref={dialogBody}>
              <div className="connection-tab-panel" role={form.databaseType === "sqlite" ? undefined : "tabpanel"} id="connection-panel-general" aria-labelledby={form.databaseType === "sqlite" ? undefined : "connection-tab-general"} hidden={connectionTab !== "general"}>
              <section className="connection-form-section">
                <div className={`connection-form-grid connection-identity-grid${form.databaseType === "sqlite" ? "" : " connection-network-grid"}`}>
                  <label className="connection-name-field">
                    {bt("business.name")}<input data-modal-focus={editingProfile ? true : undefined} value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.databaseEngine")}<select
                      data-modal-focus={editingProfile ? undefined : true}
                      value={form.databaseType}
                      onChange={(event) => {
                        const databaseType = event.target.value as SaveDataSourceInput["databaseType"];
                        setTestState({ status: "idle" });
                        setError(undefined);
                        setConnectionTab("general");
                        setForm((current) => ({
                          ...current,
                          databaseType,
                          sqlite: undefined,
                          port: databaseType === "mySql" ? 3306 : 5432,
                          database: !editingProfile && databaseType === "mySql" && current.database === initialForm.database
                            ? "" : current.database,
                          ...(databaseType === "sqlite" || current.databaseType === "sqlite"
                            ? { password: "", sshPassword: "", sshKeyPassphrase: "", security: undefined, sslMode: databaseType === "sqlite" ? "disable" as const : defaultSslMode }
                            : {}),
                        }));
                      }}
                      disabled={!enabled || pending || editingServer}
                    >
                      <option value="postgreSql">PostgreSQL</option>
                      <option value="mySql">MySQL</option>
                      <option value="sqlite">SQLite</option>
                    </select>
                  </label>
                  {form.databaseType === "sqlite" ? <div className="sqlite-file-fields">
                    <label htmlFor="sqlite-file-path">{bt("sqlite.file")}</label>
                    <div className="sqlite-file-picker">
                      <input id="sqlite-file-path" readOnly value={form.sqlite?.path ?? ""} title={form.sqlite?.path} placeholder={bt("sqlite.noFile")} aria-invalid={testState.status === "error" || undefined} aria-describedby={testState.status !== "idle" ? "connection-test-detail" : "sqlite-file-help"} />
                      <button className="secondary-button" type="button" aria-label={bt("sqlite.choose")} disabled={pending} onClick={() => void pickSqlite(false)}>{bt("sqlite.chooseShort")}</button>
                    </div>
                    <p id="sqlite-file-help" className="connection-field-help">{bt("sqlite.fileHelp")}</p>
                    <details className="sqlite-file-access">
                      <summary>{bt("sqlite.fileAccess")}</summary>
                      <div>
                        <p>{bt("sqlite.folderHelp")}</p>
                        <button className="secondary-button" type="button" disabled={pending || !form.sqlite?.path} onClick={() => void pickSqlite(true)}>{bt("sqlite.folder")}</button>
                        {form.sqlite?.accessDirectory ? <small title={form.sqlite.accessDirectory}>{form.sqlite.accessDirectory}</small> : null}
                      </div>
                    </details>
                  </div> : <><label className="connection-host-field">
                    {bt("business.host")}<input value={form.host} onChange={(event) => updateField("host", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.port")}<input type="number" min={1} max={65535} value={form.port} onChange={(event) => updateField("port", Number(event.target.value))} disabled={!enabled || pending} />
                  </label>
                  <label className="connection-database-field">
                    {bt(databaseOptional ? "serverConnection.databaseOptional" : "business.database")}
                    <input value={form.database} placeholder={databaseOptional ? bt("serverConnection.databasePlaceholder") : undefined}
                      onChange={(event) => updateField("database", event.target.value)} disabled={!enabled || pending || editingServer} />
                  </label></>}
                </div>
                {form.databaseType !== "sqlite" && !(canRequireTls && unencryptedRejected) ? <div className="connection-tls-guidance connection-tls-action">
                  <p className="connection-field-help" role="status">{bt(tlsGuidance)}</p>
                  <button type="button" disabled={!enabled || pending} onClick={handleTlsGuidance}>{bt(canRequireTls ? "connectionTls.requireTls" : "connectionTls.settings")}</button>
                </div> : null}
              </section>

              <section hidden={form.databaseType === "sqlite"} className="connection-form-section" aria-labelledby="connection-access-title">
                <div className="connection-section-heading">
                  <strong id="connection-access-title">{bt("business.accessSecurity")}</strong>
                  <span className="connection-keychain-status">{bt("business.systemCredentialStorage")}</span>
                </div>
                <div className="connection-form-grid connection-access-grid">
                  <label>
                    {bt("business.username")}<input autoComplete="username" value={form.username} onChange={(event) => updateField("username", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.password")}<input aria-label={bt("business.password")} type="password" autoComplete="current-password" placeholder={editingProfile && !pendingLocalSetup ? bt("business.optionalKeepCurrentPassword") : bt("business.databasePassword")} value={form.password} onChange={(event) => updateField("password", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <p className="connection-credential-note">
                    {editingProfile && !pendingLocalSetup
                      ? bt("business.leaveBlankToKeepThePasswordAlreadyStoredIn")
                      : bt("business.thePasswordIsSavedToTheSystemCredentialStore")}
                  </p>
                </div>
              </section>
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-tls" aria-labelledby="connection-tab-tls" hidden={form.databaseType === "sqlite" || connectionTab !== "tls"}>
                <div className="connection-security-setting">
                  <div>
                    <strong>{bt("business.transportSecurity")}</strong>
                    <span>{sslModeDescriptions[form.sslMode]}</span>
                  </div>
                  <label>
                    <span>{bt("business.sSLMode")}</span>
                    <select value={form.sslMode} onChange={(event) => updateField("sslMode", event.target.value as SslMode)} disabled={!enabled || pending}>
                      <option value="disable">{bt("business.disable")}</option>
                      <option value="prefer">{bt("business.prefer")}</option>
                      <option value="require">{bt("business.require")}</option>
                      <option value="verifyCa">{bt("business.verifyCA")}</option>
                      <option value="verifyFull">{bt("business.verifyFull")}</option>
                    </select>
                  </label>
                </div>
                <ConnectionSecurityFields section="tls" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending} platform={platform} onChange={(security) => updateField("security", security)} sshPassword={form.sshPassword} onSshPasswordChange={(password) => updateField("sshPassword", password)} hasSavedSshPassword={hasSavedSshPassword} />
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-ssh" aria-labelledby="connection-tab-ssh" hidden={form.databaseType === "sqlite" || connectionTab !== "ssh"}>
                <ConnectionSecurityFields section="ssh" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending} platform={platform} onChange={updateSshSecurity} sshPassword={form.sshPassword} onSshPasswordChange={(password) => updateField("sshPassword", password)} hasSavedSshPassword={hasSavedSshPassword} sshKeyPassphrase={form.sshKeyPassphrase} onSshKeyPassphraseChange={(passphrase) => updateField("sshKeyPassphrase", passphrase)} />
              </div>
                {editingProfile && !editingServer && !requiresLiveVerification && testState.status === "idle" ? (
                  <div className="connection-live-action">
                    <div>
                      <strong>{bt("business.liveDatabase")}</strong>
                      <span>
                        {requiresLiveVerification
                          ? bt("business.connectionDetailsChangedVerifyBeforeSavingAndReplaceThe")
                          : bt(form.databaseType === "sqlite" ? "sqlite.refreshSavedFile" : "business.connectNowUsingTheSavedDatabasePasswordAndReplace")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void verifyAndRefreshEditingSource()}
                      disabled={!enabled || pending}
                    >
                      {pending ? bt("business.working") : bt("business.verifyRefresh")}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="connection-dialog-feedback">
                <ConnectionTestStatus state={testState} form={form} onCancel={cancelConnectionTest}
                  onRequireTls={canRequireTls && enabled && !pending && !invalidScope ? requireTlsAndRetest : undefined} />
                {requiresLiveVerification && testState.status === "idle" ? <p className="connection-test-hint">{bt(pendingLocalSetup
                  ? form.databaseType === "sqlite" ? "connectionSync.setupSqlite" : "connectionSync.setupNetwork"
                  : "business.connectionDetailsChangedTestTheConnectionBeforeSaving")}</p> : null}
                {error ? <p className="error-message" role="alert">{error}</p> : null}
              </div>
              <footer>
                <div className="connection-footer-leading">
                  <button type="button" className="secondary-button" onClick={() => void testConnection()} disabled={!enabled || pending || invalidScope}>{testState.status === "testing" ? bt("business.testing") : bt("business.testConnection")}</button>
                {editingProfile ? (
                  <div className="connection-danger-action">
                    <button type="button" className="delete-source-button" onClick={() => {
                      void deleteSource(editingProfile).catch((reason: unknown) => setError(connectionFailure(reason).message));
                    }} disabled={pending}>{bt("business.deleteDataSource")}</button>
                    <span>{bt("business.removesLocalDataOnly")}</span>
                  </div>
                ) : null}
                </div>
                <div className="connection-footer-actions">
                  <button type="button" className="secondary-button" onClick={closeDialog} disabled={pending}>{bt("business.cancel")}</button>

                  <button type="submit" className="connection-primary-button" disabled={!enabled || pending || invalidScope || ((!editingProfile || requiresLiveVerification) && testState.status !== "success")}>

                    {pending && testState.status !== "testing"
                      ? bt(editingProfile || serverForm ? "business.saving" : "business.readingSchema")
                      : bt(editingProfile ? "business.saveChanges" : serverForm ? "serverConnection.save" : "business.saveAndMap")}
                  </button>
                </div>
              </footer>
            </form>
          </section>
        </div>
        </ModalSurface>
      ) : null}
    </section>
  );
}
