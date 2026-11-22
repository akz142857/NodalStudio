import { describe, expect, it } from "vitest";
import type { QueryCell } from "../../platform/types";
import { diagramColumn, diagramTable } from "../../test/diagram-comparison-fixture";
import { queryRowStatements, sqliteRowStatements } from "./row-statements";

const text = (value: string): QueryCell => ({ kind: "text", value, truncated: false });
const column = (name: string, databaseType: string) => ({ name, databaseType });

describe("row statements", () => {
  it("preserves exact MySQL numbers and uses every part of a composite primary key", () => {
    const table = diagramTable("odd`table", [
      diagramColumn("id"), diagramColumn("account"), diagramColumn("amount"), diagramColumn("path"),
      { ...diagramColumn("created_at"), defaultValue: "CURRENT_TIMESTAMP", generated: true },
      { ...diagramColumn("computed"), generated: true },
    ]);
    table.primaryKey = { name: "PRIMARY", columns: ["account", "id"] };
    const result = queryRowStatements({ table, dialect: "mySql" }, [
      column("account", "VARCHAR"), column("id", "BIGINT UNSIGNED"), column("amount", "DECIMAL"),
      column("path", "TEXT"), column("created_at", "TIMESTAMP"),
    ], [text("O'Reilly"), text("18446744073709551615"), text("107.2000000000001"), text("a\\b"), text("2026-11-22 10:00:00")]);
    expect(result.insert).toEqual({ sql: "INSERT INTO `public`.`odd``table` (`id`, `account`, `amount`, `path`, `created_at`) VALUES (18446744073709551615, 'O''Reilly', 107.2000000000001, CONVERT(X'615c62' USING utf8mb4), '2026-11-22 10:00:00');" });
    expect(result.update).toEqual({ sql: "UPDATE `public`.`odd``table` SET `amount` = 107.2000000000001, `path` = CONVERT(X'615c62' USING utf8mb4), `created_at` = '2026-11-22 10:00:00' WHERE `account` = 'O''Reilly' AND `id` = 18446744073709551615;" });
  });

  it("copies PostgreSQL identity and raw JSON values without rounding them", () => {
    const table = diagramTable('order"log', [
      { ...diagramColumn("id"), identity: "always" }, diagramColumn("data"), diagramColumn("note"),
    ]);
    const result = queryRowStatements({ table, dialect: "postgreSql" }, [
      column("id", "INT8"), column("data", "JSONB"), column("note", "TEXT"),
    ], [text("9223372036854775807"), { kind: "json", value: {}, raw: '{"id": 9223372036854775806}', truncated: false }, { kind: "null" }]);
    expect(result.insert).toEqual({ sql: `INSERT INTO "public"."order""log" ("id", "data", "note") OVERRIDING SYSTEM VALUE VALUES (9223372036854775807, '{"id": 9223372036854775806}', NULL);` });
    expect(result.update).toEqual({ sql: `UPDATE "public"."order""log" SET "data" = '{"id": 9223372036854775806}', "note" = NULL WHERE "id" = 9223372036854775807;` });
  });

  it("requires all values to be available and a complete key for UPDATE", () => {
    const table = diagramTable("orders", [diagramColumn("id"), diagramColumn("note")]);
    const columns = [column("id", "INT8"), column("note", "TEXT")];
    expect(queryRowStatements({ table: { ...table, primaryKey: null }, dialect: "postgreSql" }, columns,
      [text("1"), text("ok")]).update).toEqual({ reason: "missingKey" });
    expect(queryRowStatements({ table, dialect: "postgreSql" }, columns,
      [{ kind: "null" }, text("ok")]).update).toEqual({ reason: "missingKey" });
    expect(queryRowStatements({ table, dialect: "postgreSql" }, columns,
      [text("1"), { kind: "text", value: "part", truncated: true }])).toEqual({
      insert: { reason: "incompleteValues" }, update: { reason: "incompleteValues" },
    });
  });

  it("copies only the values supplied in a new SQLite draft", () => {
    const columns = [
      { name: "id", declaredType: "INTEGER", generated: false, primaryKey: true },
      { name: "amount", declaredType: "REAL", generated: false, primaryKey: false },
    ];
    expect(sqliteRowStatements("orders", columns, undefined, new Map(), false)).toEqual({
      insert: { sql: 'INSERT INTO "main"."orders" DEFAULT VALUES;' }, update: { reason: "missingKey" },
    });
    expect(sqliteRowStatements("orders", columns, undefined, new Map([[1, { kind: "real", value: "4" }]]), false).insert)
      .toEqual({ sql: 'INSERT INTO "main"."orders" ("amount") VALUES (4.0);' });
  });
});
