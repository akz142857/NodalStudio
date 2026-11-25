import { useI18n } from "../i18n";
import type { Translate } from "../i18n/messages";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ConnectionTestStatus } from "./ConnectionTestStatus";
import { connectionFailure, type ConnectionTestState } from "./connection-test-state";
import { ConnectionSecurityFields } from "./ConnectionSecurityFields";
import { ConnectionManager } from "./ConnectionManager";
import { SchemaObjectMenu } from "./SchemaObjectMenu";
import { DataSourcePicker } from "./DataSourcePicker";
import { DatabaseServerBrowser, type DatabaseCatalogResult } from "./DatabaseServerBrowser";
import { SearchSelect } from "./SearchSelect";
import { isSavedConnection, isServerConnection, isServerConnectionForm, lastServerDatabase, rememberServerDatabase } from "../platform/database-server";
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
  onActiveConnectionChange?: (connectionId: string | undefined) => void;
  onSourceSaved?: (source: DataSourceProfile) => void;
  onSourceOpenStart?: () => void;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  onSourceDeleted?: (sourceId: string) => void;
  defaultDatabaseType: SaveDataSourceInput["databaseType"];
  defaultSslMode: SslMode;
}

class MissingSchemaSnapshotError extends Error {}

type DatabaseCatalog = { serverKey: string } & ({ state: "loading" } | DatabaseCatalogResult);

const serverKey = (server: DataSourceProfile) => JSON.stringify([server.id, server.updatedAt]);

function newConnectionForm(
  databaseType: SaveDataSourceInput["databaseType"],
  sslMode: SslMode,
): SaveDataSourceInput {
  return {
    displayName: "",
    host: "",
    database: "",
    username: "",
    password: "",
    databaseType,
    port: databaseType === "mySql" ? 3306 : 5432,
    sslMode,
  };
}

type DraftIssue = { field: string; message: string };

function newConnectionIssue(input: SaveDataSourceInput, namedDatabase: boolean, t: Translate): DraftIssue | undefined {
  if (input.databaseType === "sqlite") {
    return input.sqlite?.path ? undefined : { field: "sqlite-choose-file", message: t("connectionSetup.fileRequired") };
  }
  if (!input.host.trim()) return { field: "connection-host", message: t("connectionSetup.hostRequired") };
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { field: "connection-port", message: t("connectionSetup.portRequired") };
  }
  if (!input.username.trim()) return { field: "connection-username", message: t("connectionSetup.usernameRequired") };
  if (!input.password) return { field: "connection-password", message: t("connectionSetup.passwordRequired") };
  if (namedDatabase && !input.database.trim()) return { field: "connection-database", message: t("connectionSetup.databaseRequired") };
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

export function ConnectionPanel({ enabled, activeSourceId, initializingDatabase, sourcesRevision, children, platform, onSnapshot, onOpenDatabase, onDatabaseCleared, onActiveConnectionChange, onSourceSaved, onSourceOpenStart, onSourceDeleted, onRefresh, refreshDisabled, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
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
  const [draft, setForm] = useState<SaveDataSourceInput>(() => newConnectionForm(defaultDatabaseType, defaultSslMode));
  const [namedDatabase, setNamedDatabase] = useState(false);
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
  useEffect(() => {
    const panel = dialogBody.current?.querySelector<HTMLElement>(".connection-tab-panel:not([inert])");
    if (panel) panel.scrollTop = 0;
  }, [connectionTab]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DataSourceProfile>();
  const [serverBrowser, setServerBrowser] = useState<{ server: DataSourceProfile; mode: "first" | "create" | "browse" }>();
  const [selectedServer, setSelectedServer] = useState<{ id: string; previousSourceId?: string }>();
  const [databaseCatalog, setDatabaseCatalog] = useState<DatabaseCatalog>();
  const [databaseError, setDatabaseError] = useState<{ context: typeof openContext; server: DataSourceProfile; database: string; message: string }>();
  const [pendingDatabase, setPendingDatabase] = useState<{ connection: DataSourceProfile; database: string }>();
  const databaseStatusId = useId();
  const databaseRequest = useRef<{ serverKey: string; result: Promise<DatabaseCatalogResult> }>(undefined);
  const openingDatabase = useRef(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    profile: DataSourceProfile;
    resolve: (confirmed: boolean) => void;
  }>();
  const pendingLocalSetup = editingProfile?.connectionSync?.pending === true;
  const form = editingProfile ? draft : {
    ...draft,
    database: draft.databaseType !== "sqlite" && namedDatabase ? draft.database.trim() : "",
    displayName: draft.displayName.trim() || (draft.databaseType === "sqlite"
      ? draft.sqlite?.path.split(/[\\/]/).pop() ?? ""
      : (namedDatabase ? draft.database.trim() : "") || draft.host.trim()),
  };
  const serverForm = isServerConnectionForm(form);
  const browsingNewServer = !editingProfile && form.databaseType !== "sqlite" && !namedDatabase;
  const editingServer = editingProfile ? isServerConnection(editingProfile) : false;
  const invalidScope = Boolean(editingProfile && serverForm && !editingServer);
  const canRequireTls = form.databaseType !== "sqlite" && (form.sslMode === "disable" || form.sslMode === "prefer");
  const advancedConnectionSettings = connectionTab !== "general";
  const requiresLiveVerification = editingProfile
    ? pendingLocalSetup || connectionDetailsDiffer(editingProfile, form) || Boolean(form.sshPassword || form.sshKeyPassphrase || form.password)
    : false;

  const savedSsh = pendingLocalSetup ? undefined : editingProfile?.security?.ssh;
  const formSsh = form.security?.ssh;
  const hostHelp = formSsh ? bt("business.theDatabaseHostAboveIsResolvedFromTheJump")
    : !editingProfile ? bt("connectionSetup.hostHelp") : undefined;
  const hasSavedSshPassword = savedSsh?.authentication === "password" && formSsh?.host === savedSsh.host
    && formSsh?.port === savedSsh.port && formSsh?.username === savedSsh.username;

  const connections = profiles.filter(isSavedConnection);
  const serverProfiles = connections.filter(isServerConnection);
  const activeProfile = profiles.find((profile) => profile.id === activeSourceId);
  const parentServer = serverProfiles.find((server) => server.id === activeProfile?.serverSourceId);
  const browsingServer = serverProfiles.find((server) => server.id === selectedServer?.id);
  // A workspace loaded elsewhere takes over the sidebar selection.
  if (selectedServer && activeSourceId && activeSourceId !== selectedServer.previousSourceId) setSelectedServer(undefined);
  const activeConnection = browsingServer ?? parentServer ?? (activeProfile && isSavedConnection(activeProfile) ? activeProfile : undefined);
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
  const databaseOptions = useMemo(() => catalog?.state === "ready"
    ? catalog.databases.map((name) => ({ value: name, label: name })) : [], [catalog]);

  function validateDraft(input: SaveDataSourceInput) {
    const issue = editingProfile ? undefined : newConnectionIssue(input, namedDatabase, bt);
    if (!issue) return true;
    setConnectionTab("general");
    setError(issue.message);
    requestAnimationFrame(() => document.getElementById(issue.field)?.focus());
    return false;
  }

  useEffect(() => {
    if (parentServer && activeProfile?.database) rememberServerDatabase(parentServer.id, activeProfile.database);
  }, [parentServer, activeProfile?.database]);

  const activeConnectionId = activeConnection?.id;
  useEffect(() => { onActiveConnectionChange?.(activeConnectionId); }, [activeConnectionId, onActiveConnectionChange]);

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
      const sameAccount = old && next && old.authentication === next.authentication
        && old.host === next.host && old.port === next.port && old.username === next.username;
      return {
        ...current,
        security,
        sshPassword: sameAccount ? current.sshPassword : "",
        sshKeyPassphrase: sameAccount && old.privateKey === next.privateKey ? current.sshKeyPassphrase : "",
      };
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
    if (!enabled || pending || invalidScope || testController.current || !validateDraft(input)) return false;
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
      if (testController.current !== controller) return false;
      if (controller.signal.aborted) {
        setTestState((current) => ({ status: "cancelled", progress: current.status === "testing" ? current.progress : undefined }));
        return false;
      }
      setTestState({ status: "success", result });
      return true;
    } catch (reason) {
      if (testController.current !== controller) return false;
      const failure = connectionFailure(reason);
      if (failure.code === "passwordRequired" || failure.code === "postgresMaintenanceUnavailable") setConnectionTab("general");
      if (controller.signal.aborted || failure.stage === "cancelled") setTestState((current) => ({ status: "cancelled", progress: current.status === "testing" ? current.progress : undefined }));
      else setTestState((current) => ({ status: "error", failure, progress: current.status === "testing" ? current.progress : undefined }));
      return false;
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
    setForm((current) => ({ ...current, sslMode: "require" }));
    void testConnection(encrypted);
  }

  function cancelConnectionTest() {
    const controller = testController.current;
    if (!controller || controller.signal.aborted) return;
    setTestState((current) => current.status === "testing" ? { ...current, cancelling: true } : current);
    controller.abort();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || pending || invalidScope || testController.current) return;
    if (!editingProfile && testState.status !== "success" && !await testConnection()) return;
    if (requiresLiveVerification && testState.status !== "success") return;
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
      if (isServerConnection(profile)) {
        selectServer(profile, requiresLiveVerification);
        if (!editingProfile) setServerBrowser({ server: profile, mode: "first" });
      }
      else if (mapped) onSnapshot(mapped.capture);
      setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "", sshKeyPassphrase: "" }));
      setDialogOpen(false);
    } catch (reason) {
      if (pendingLocalSetup && serverForm) setTestState({ status: "idle" });
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

  const loadDatabases = useCallback((server: DataSourceProfile): Promise<DatabaseCatalogResult> => {
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
  }, [platform]);

  function acceptServerDatabase(server: DataSourceProfile, profile: DataSourceProfile, capture: CaptureSnapshotResult) {
    rememberServerDatabase(server.id, profile.database);
    onSourceSaved?.(profile);
    setProfiles((current) => [profile, ...current.filter((source) => source.id !== profile.id)]);
    (onOpenDatabase ?? onSnapshot)(capture);
  }

  async function chooseDatabase(server: DataSourceProfile, database: string) {
    if (openingDatabase.current) return;
    openingDatabase.current = true;
    onSourceOpenStart?.();
    setOpenError(undefined);
    setDatabaseError(undefined);
    setPendingDatabase({ connection: server, database });
    setPending(true);
    try {
      // The native open command uses a current local snapshot before accessing the network.
      const { profile, capture } = await platform.openServerDatabase(server.id, database, server.updatedAt);
      acceptServerDatabase(server, profile, capture);
    } catch (reason) {
      setDatabaseError({ context: openContext, server, database, message: translateConnectionFailure(connectionFailure(reason), bt) });
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
      if (lastDatabase) await chooseDatabase(profile, lastDatabase);
      else selectServer(profile);
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
    setForm(newConnectionForm(defaultDatabaseType, defaultSslMode));
    setNamedDatabase(false);
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
      setSelectedServer((current) => current?.id === profile.id ? undefined : current);
      setOpenError((current) => current?.profile.id === profile.id ? undefined : current);
      if (profile.id === editingProfile?.id) {
        setDialogOpen(false);
        setEditingProfile(undefined);
      }
      onSourceDeleted?.(profile.id);
      if (activeConnection?.id === profile.id) onSourceOpenStart?.();
      if (activeProfile?.serverSourceId === profile.id) onDatabaseCleared?.();
      const nextProfile = connections.find((item) => item.id !== profile.id && !isServerConnection(item));
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
              disabled={!enabled || pending || Boolean(databaseStatus) || activeServer.connectionSync?.pending} onClick={() => setServerBrowser({ server: activeServer, mode: "create" })}><ActionIcon name="add" /></Button>}
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
          <Button size="small" disabled={pending} onClick={() => setServerBrowser({ server: visibleDatabaseError.server, mode: "browse" })}>
            {bt("connectionSetup.chooseAnother")}
          </Button>
        </div>}
        <p id={databaseStatusId} className={databaseStatus ? "source-database-status" : "visually-hidden"} aria-live="polite" aria-atomic="true">
          {databaseStatus && !activeConnection && <span className="search-select-progress" aria-hidden="true" />}{databaseStatus}
        </p>
      </div>}
      {serverBrowser ? <DatabaseServerBrowser key={serverBrowser.server.id} server={serverBrowser.server} platform={platform}
        loadCatalog={loadDatabases} startCreating={serverBrowser.mode === "create"} firstSelection={serverBrowser.mode === "first"}
        onOpenStart={onSourceOpenStart} onClose={() => setServerBrowser(undefined)}
        onOpen={(profile, capture) => {
          setDatabaseError(undefined);
          acceptServerDatabase(serverBrowser.server, profile, capture);
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
      {managerOpen ? <ConnectionManager profiles={connections} activeConnectionId={activeConnection?.id} pending={pending} platform={platform}
        startWithImport={managerOpen === "import"} onClose={() => setManagerOpen(undefined)}
        onCreate={() => { setManagerOpen(undefined); openCreateDialog(); }}
        onEdit={(profile) => { setManagerOpen(undefined); openEditDialog(profile); }}
        onOpen={(profile) => { setManagerOpen(undefined); if (profile.id !== activeConnection?.id) void handleExistingOpen(profile); }}
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
            <p id="delete-connection-detail">{bt(isServerConnection(deleteConfirmation.profile) ? "serverConnection.removeImpact" : "business.deleteConnectionImpact")}</p>
            <footer>
              <Button data-modal-focus onClick={() => finishDeleteConfirmation(false)}>{bt("business.cancel")}</Button>
              <Button variant="danger" onClick={() => finishDeleteConfirmation(true)}>{bt("businessMeta.delete")}</Button>
            </footer>
          </section>
        </div>
      </ModalSurface> : null}

      {dialogOpen ? (
        <ModalSurface labelledBy="connection-dialog-title" describedBy="connection-dialog-description" onDismiss={closeDialog}>
        <div className="connection-dialog-backdrop connection-sheet-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <section className="connection-dialog">
            <header>
              <h2 id="connection-dialog-title">
                {editingProfile ? bt("business.edit", { value0: editingProfile.displayName }) : bt("business.createDatabaseConnection")}
              </h2>
            </header>
            <p id="connection-dialog-description" className={form.databaseType !== "sqlite" && !editingProfile ? "visually-hidden" : "dialog-description"}>
              {form.databaseType === "sqlite" ? bt("sqlite.readonly")
                : editingProfile ? bt("business.testConnectionChangesBeforeSavingExistingPasswordsAreReused")
                  : bt("connectionSetup.intro")}
            </p>
            <form className="connection-panel" noValidate={!editingProfile} onSubmit={(event) => void handleSubmit(event)}>
              {form.databaseType !== "sqlite" && <div className="connection-tabs" role="tablist" aria-label={bt("business.connectionSettings")}>
                {([["general", bt("business.connection")], ["tls", "TLS"], ["ssh", "SSH"]] as const).map(([tab, label], index, tabs) => <button
                  key={tab} type="button" role="tab" id={`connection-tab-${tab}`} aria-controls={`connection-panel-${tab}`}
                  aria-selected={connectionTab === tab} tabIndex={connectionTab === tab ? 0 : -1}
                  onClick={() => setConnectionTab(tab)}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                    const next = tabs[nextIndex][0];
                    setConnectionTab(next);
                    document.getElementById(`connection-tab-${next}`)?.focus();
                  }}>{label}</button>)}
              </div>}
              <div className="connection-dialog-body" ref={dialogBody}>
                <div className="connection-tab-panel" id="connection-panel-general" inert={advancedConnectionSettings}
                  aria-hidden={advancedConnectionSettings || undefined}
                  role={form.databaseType !== "sqlite" ? "tabpanel" : undefined}
                  aria-labelledby={form.databaseType !== "sqlite" ? "connection-tab-general" : undefined}>
                  <div className="connection-sheet-group">
                    <div className="connection-sheet-row">
                      <label htmlFor="connection-engine">{bt("business.databaseEngine")}</label>
                      <select id="connection-engine" data-modal-focus={!editingProfile || undefined} value={form.databaseType}
                        onChange={(event) => {
                          const databaseType = event.target.value as SaveDataSourceInput["databaseType"];
                          setTestState({ status: "idle" });
                          setError(undefined);
                          setForm((current) => ({
                            ...current,
                            databaseType,
                            sqlite: undefined,
                            port: databaseType === "mySql" ? 3306 : 5432,
                            ...(databaseType === "sqlite" || current.databaseType === "sqlite"
                              ? { password: "", sshPassword: "", sshKeyPassphrase: "", security: undefined, sslMode: databaseType === "sqlite" ? "disable" as const : defaultSslMode }
                              : {}),
                          }));
                        }}
                        disabled={!enabled || pending || editingServer}>
                        <option value="postgreSql">PostgreSQL</option>
                        <option value="mySql">MySQL</option>
                        <option value="sqlite">SQLite</option>
                      </select>
                    </div>
                    <div className="connection-sheet-row">
                      <label htmlFor="connection-name">{bt(editingProfile ? "business.name" : "connectionSetup.optionalName")}</label>
                      <input id="connection-name" data-modal-focus={!!editingProfile || undefined} value={draft.displayName}
                        placeholder={editingProfile ? undefined : form.displayName || bt("connectionSetup.namePlaceholder")}
                        onChange={(event) => updateField("displayName", event.target.value)} disabled={!enabled || pending} />
                    </div>
                  </div>
                  {form.databaseType === "sqlite" ? (
                    <div className="connection-sheet-group">
                      <div className="connection-sheet-row">
                        <label htmlFor="sqlite-file-path">{bt("sqlite.file")}</label>
                        <div className="connection-file-picker">
                          <input id="sqlite-file-path" readOnly value={form.sqlite?.path ?? ""} title={form.sqlite?.path}
                            placeholder={bt("sqlite.noFile")} aria-invalid={testState.status === "error" || undefined}
                            aria-describedby={testState.status !== "idle" ? "connection-test-detail" : "sqlite-file-help"} />
                          <button id="sqlite-choose-file" type="button" aria-label={bt("sqlite.choose")} disabled={pending}
                            onClick={() => void pickSqlite(false)}>{bt("sqlite.chooseShort")}</button>
                        </div>
                        <p id="sqlite-file-help" className="connection-field-help">{bt("sqlite.fileHelp")}</p>
                      </div>
                      <details className="sqlite-file-access">
                        <summary>{bt("sqlite.fileAccess")}</summary>
                        <div>
                          <p>{bt("sqlite.folderHelp")}</p>
                          <button type="button" disabled={pending || !form.sqlite?.path}
                            onClick={() => void pickSqlite(true)}>{bt("sqlite.folder")}</button>
                          {form.sqlite?.accessDirectory && <small title={form.sqlite.accessDirectory}>{form.sqlite.accessDirectory}</small>}
                        </div>
                      </details>
                    </div>
                  ) : (
                    <>
                      <div className="connection-sheet-group">
                        <div className="connection-sheet-row">
                          <label htmlFor="connection-host">{bt("business.host")}</label>
                          <div className="connection-address">
                            <input id="connection-host" value={form.host} placeholder={editingProfile ? undefined : "db.example.com"}
                              autoCapitalize="none" spellCheck={false} aria-required="true" aria-describedby={hostHelp ? "connection-host-help" : undefined}
                              onChange={(event) => updateField("host", event.target.value)} disabled={!enabled || pending} />
                            <label htmlFor="connection-port">{bt("business.port")}</label>
                            <input id="connection-port" type="number" min={1} max={65535} value={form.port || ""} aria-required="true"
                              onChange={(event) => updateField("port", Number(event.target.value))} disabled={!enabled || pending} />
                          </div>
                          {hostHelp && <p id="connection-host-help" className="connection-field-help">{hostHelp}</p>}
                        </div>
                        <div className="connection-sheet-row">
                          <label htmlFor="connection-username">{bt("business.username")}</label>
                          <input id="connection-username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                            aria-required="true" value={form.username} onChange={(event) => updateField("username", event.target.value)}
                            disabled={!enabled || pending} />
                        </div>
                        <div className="connection-sheet-row">
                          <label htmlFor="connection-password">{bt("business.password")}</label>
                          <input id="connection-password" aria-required={!editingProfile || pendingLocalSetup} aria-describedby="connection-password-help"
                            type="password" autoComplete="current-password" value={form.password} onChange={(event) => updateField("password", event.target.value)}
                            disabled={!enabled || pending} />
                          <p id="connection-password-help" className="connection-field-help">
                            {editingProfile && !pendingLocalSetup ? bt("business.leaveBlankToKeepThePasswordAlreadyStoredIn")
                              : bt("business.thePasswordIsSavedToTheSystemCredentialStore")}
                          </p>
                        </div>
                      </div>
                      {(!editingProfile || !editingServer) && <div className="connection-sheet-group">
                        {!editingProfile && <div className="connection-sheet-row">
                          <label htmlFor="connection-destination">{bt("business.database")}</label>
                          <select id="connection-destination" value={namedDatabase ? "named" : "browse"}
                            disabled={!enabled || pending} onChange={(event) => {
                              setNamedDatabase(event.target.value === "named");
                              setTestState({ status: "idle" });
                              setError(undefined);
                            }}>
                            <option value="browse">{bt("connectionSetup.browse")}</option>
                            <option value="named">{bt("connectionSetup.enterDatabase")}</option>
                          </select>
                        </div>}
                        {(editingProfile || namedDatabase) && <div className="connection-sheet-row">
                          <label htmlFor="connection-database">{bt(editingProfile ? "business.database" : "serverConnection.databaseName")}</label>
                          <input id="connection-database" aria-required="true" autoCapitalize="none" spellCheck={false} value={draft.database}
                            onChange={(event) => updateField("database", event.target.value)} disabled={!enabled || pending} />
                        </div>}
                      </div>}
                    </>
                  )}
                  {editingProfile && !editingServer && !requiresLiveVerification && testState.status === "idle" && (
                    <div className="connection-live-action">
                      <div>
                        <strong>{bt("business.liveDatabase")}</strong>
                        <span>{bt(form.databaseType === "sqlite" ? "sqlite.refreshSavedFile" : "business.connectNowUsingTheSavedDatabasePasswordAndReplace")}</span>
                      </div>
                      <button type="button" className="secondary-button" onClick={() => void verifyAndRefreshEditingSource()} disabled={!enabled || pending}>
                        {pending ? bt("business.working") : bt("business.verifyRefresh")}
                      </button>
                    </div>
                  )}
                </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-tls" aria-labelledby="connection-tab-tls"
                hidden={form.databaseType === "sqlite"} inert={connectionTab !== "tls"} aria-hidden={connectionTab !== "tls" || undefined}>
                <div className="connection-sheet-group">
                  <div className="connection-sheet-row">
                    <label htmlFor="connection-ssl-mode">{bt("business.sSLMode")}</label>
                    <select id="connection-ssl-mode" value={form.sslMode} aria-describedby="connection-ssl-help"
                      onChange={(event) => updateField("sslMode", event.target.value as SslMode)} disabled={!enabled || pending}>
                      <option value="disable">{bt("business.disable")}</option>
                      <option value="prefer">{bt("business.prefer")}</option>
                      <option value="require">{bt("business.require")}</option>
                      <option value="verifyCa">{bt("business.verifyCA")}</option>
                      <option value="verifyFull">{bt("business.verifyFull")}</option>
                    </select>
                    <div id="connection-ssl-help" className="connection-field-help">
                      <p>{bt("connectionSetup.tlsHelp")}</p>
                      <p>{sslModeDescriptions[form.sslMode]}</p>
                    </div>
                  </div>
                </div>
                <ConnectionSecurityFields section="tls" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending}
                  platform={platform} onChange={(security) => updateField("security", security)} />
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-ssh" aria-labelledby="connection-tab-ssh"
                hidden={form.databaseType === "sqlite"} inert={connectionTab !== "ssh"} aria-hidden={connectionTab !== "ssh" || undefined}>
                <ConnectionSecurityFields section="ssh" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending} platform={platform} onChange={updateSshSecurity} sshPassword={form.sshPassword} onSshPasswordChange={(password) => updateField("sshPassword", password)} hasSavedSshPassword={hasSavedSshPassword} sshKeyPassphrase={form.sshKeyPassphrase} onSshKeyPassphraseChange={(passphrase) => updateField("sshKeyPassphrase", passphrase)} />
              </div>
              </div>
              <footer className="connection-sheet-footer">
                {testState.status !== "idle" || requiresLiveVerification || error ? <div className="connection-dialog-feedback">
                  <ConnectionTestStatus state={testState} form={form}
                    onRequireTls={canRequireTls && enabled && !pending && !invalidScope ? requireTlsAndRetest : undefined} />
                  {requiresLiveVerification && testState.status === "idle" ? <p className="connection-test-hint">{bt(pendingLocalSetup
                    ? form.databaseType === "sqlite" ? "connectionSync.setupSqlite" : "connectionSync.setupNetwork"
                    : "business.connectionDetailsChangedTestTheConnectionBeforeSaving")}</p> : null}
                  {error ? <p className="error-message" role="alert">{error}</p> : null}
                </div> : null}
                <div className="connection-sheet-actions">
                  <div className="connection-footer-leading">
                    <button type="button" className="secondary-button"
                      aria-label={testState.status === "testing" ? bt("business.cancelConnectionTest") : undefined}
                      onClick={testState.status === "testing" ? cancelConnectionTest : () => void testConnection()}
                      disabled={testState.status === "testing" ? testState.cancelling : !enabled || pending || invalidScope}>
                      {bt(testState.status === "testing" ? testState.cancelling ? "business.cancelling" : "business.cancelTest" : "business.testConnection")}
                    </button>
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
                    <button type="submit" className="connection-primary-button" disabled={!enabled || pending || invalidScope || (requiresLiveVerification && testState.status !== "success")}>
                      {bt(pending && testState.status !== "testing" && testState.status === "success"
                        ? editingProfile || serverForm ? "business.saving" : "business.readingSchema"
                        : editingProfile ? "business.saveChanges"
                          : browsingNewServer ? "connectionSetup.continueToDatabases"
                            : form.databaseType === "sqlite" ? "connectionSetup.openFile" : "connectionSetup.connectDatabase")}
                    </button>
                  </div>
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
