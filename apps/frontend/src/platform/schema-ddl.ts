import type { CaptureSnapshotResult, DataSourceProfile } from "./types";

export type SchemaDdlTarget =
  | { databaseType: "sqlite"; sourceId: string; filePath: string }
  | { databaseType: "postgreSql" | "mySql"; sourceId: string; host: string; port: number; database: string; username: string; profileUpdatedAt: string };

export type SchemaDdlInput = SchemaDdlTarget & { sql: string };

export type SchemaDdlReceipt =
  | { kind: "refreshed"; capture: CaptureSnapshotResult }
  | { kind: "refreshFailed"; message: string }
  | { kind: "outcomeUnknown" };

export function schemaDdlTarget(profile: DataSourceProfile): SchemaDdlTarget | undefined {
  const { id: sourceId, databaseType, database, host, port, username, updatedAt: profileUpdatedAt } = profile;
  if (databaseType === "sqlite") return profile.sqlite?.path ? { databaseType, sourceId, filePath: profile.sqlite.path } : undefined;
  if (!host.trim() || !port || !username.trim() || !database.trim()) return undefined;
  return { databaseType, sourceId, host, port, database, username, profileUpdatedAt };
}

export function schemaDdlTargetKey(target: SchemaDdlTarget) {
  return target.databaseType === "sqlite"
    ? JSON.stringify([target.sourceId, target.databaseType, target.filePath])
    : JSON.stringify([target.sourceId, target.databaseType, target.host, target.port, target.database, target.username, target.profileUpdatedAt]);
}

export const ddlEngineNames = { sqlite: "SQLite", postgreSql: "PostgreSQL", mySql: "MySQL" } as const;
