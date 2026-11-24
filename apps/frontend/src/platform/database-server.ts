import type { DataSourceProfile } from "./types";

type ConnectionTarget = Pick<DataSourceProfile, "databaseType" | "database">;

export function isServerConnection(source: ConnectionTarget): boolean {
  return (source.databaseType === "mySql" || source.databaseType === "postgreSql") && source.database === "";
}

export function isServerConnectionForm(form: ConnectionTarget): boolean {
  return isServerConnection({ databaseType: form.databaseType, database: form.database.trim() });
}
