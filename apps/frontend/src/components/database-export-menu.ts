import type { Translate } from "../i18n";
import type { DumpMode } from "../platform/database-export";
import type { SchemaObjectMenuAction } from "./SchemaObjectMenu";

export function dumpSqlMenu(t: Translate, onDump: (mode: DumpMode) => void, usesSsh = false): SchemaObjectMenuAction {
  if (usesSsh) return { label: t("databaseExport.sshDumpMenu"), disabled: true, run: () => {} };
  return {
    label: t("databaseExport.dump"),
    children: [
      { label: t("databaseExport.structureAndData"), run: () => onDump("structureAndData") },
      { label: t("databaseExport.structureOnly"), run: () => onDump("structureOnly") },
    ],
  };
}
