import type { DataSourceProfile } from "./types";

type ConnectionTarget = Pick<DataSourceProfile, "databaseType" | "database">;

export function isSavedConnection(profile: Pick<DataSourceProfile, "serverSourceId">): boolean {
  return !profile.serverSourceId;
}

export function isServerConnection(source: ConnectionTarget): boolean {
  return (source.databaseType === "mySql" || source.databaseType === "postgreSql") && source.database === "";
}

export function isServerConnectionForm(form: ConnectionTarget): boolean {
  return isServerConnection({ databaseType: form.databaseType, database: form.database.trim() });
}

const databasePreferenceKey = (serverId: string) => `nodalstudio.server-database.v1:${encodeURIComponent(serverId)}`;

export function lastServerDatabase(serverId: string): string | undefined {
  try { return localStorage.getItem(databasePreferenceKey(serverId)) || undefined; }
  catch { return undefined; }
}

export function rememberServerDatabase(serverId: string, database: string) {
  try { localStorage.setItem(databasePreferenceKey(serverId), database); }
  catch { /* Browsing still works without persistent preferences. */ }
}
