import { describe, expect, it } from "vitest";
import { parseDdl } from "./ddl-parser";
import type { DdlDialect, DdlRequest } from "./ddl-types";
export const ddlRequest = (text: string, dialect: DdlDialect = "postgreSql"): DdlRequest => ({ text, dialect, defaultSchema: dialect === "postgreSql" ? "public" : "shop", source: { kind: "ddl-file", name: "schema.sql", id: "test" } });
describe("bounded DDL parsing", () => {
  it("parses PostgreSQL keys, forward references, quoted names and indexes without executing input", () => {
    const sql = `CREATE TABLE "sales.eu"."Order.Items" (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE, note character varying(200) DEFAULT 'semi;colon');
CREATE UNIQUE INDEX customers_id ON public.customers (id);
CREATE TABLE public.customers (id uuid PRIMARY KEY);`;
    const result = parseDdl(ddlRequest(sql)); const order = result.schemas[1].tables[0];
    expect(result.coverage).toMatchObject({ accepted: 3, skipped: 0, errors: 0 });
    expect(order.key).toEqual({ kind: "table", schema: "sales.eu", name: "Order.Items" });
    expect(order.columns[0]).toMatchObject({ identity: "always", nullable: false, typeSchema: "ddl" });
    expect(order.columns[2].defaultValue).toBe("'semi;colon'"); expect(order.foreignKeys[0]).toMatchObject({ referencedSchema: "public", referencedTable: "customers", onDelete: "cascade" });
    expect(result.schemas[0].tables[0].indexes[0]).toMatchObject({ name: "customers_id", unique: true });
    expect(result.locations.find((value) => value.columnName === "note")).toMatchObject({ schema: "sales.eu", table: "Order.Items" });
    const span = result.locations.find((value) => value.columnName === "note")!; expect(sql.slice(span.start, span.end)).toContain("note character varying");
  });
  it("parses MySQL signed types, table FK, unique/index definitions and common table options with explicit omissions", () => {
    const result = parseDdl(ddlRequest("CREATE TABLE `parent` (`id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; CREATE TABLE `child` (id int, parent_id bigint unsigned, note varchar(80) NULL COMMENT 'a; b', CONSTRAINT child_fk FOREIGN KEY(parent_id) REFERENCES parent(id) ON DELETE SET NULL, UNIQUE KEY child_uq(id), KEY child_idx(parent_id));", "mySql"));
    expect(result.coverage).toMatchObject({ accepted: 2, skipped: 0, errors: 0, warnings: 1 });
    const parent = result.schemas[0].tables[1]; const child = result.schemas[0].tables[0];
    expect(parent.columns[0]).toMatchObject({ formattedType: "bigint unsigned", identity: "byDefault", nullable: false });
    expect(child.foreignKeys[0]).toMatchObject({ referencedSchema: "shop", onDelete: "setNull" });
    expect(child.indexes).toHaveLength(2); expect(child.columns[2].comment).toBe("a; b");
    expect(result.diagnostics.some((value) => value.message.includes("charset"))).toBe(true);
  });
  it("does not retain DML or COPY data in the model or diagnostics and resumes only after the COPY terminator", () => {
    const result = parseDdl(ddlRequest("CREATE TABLE a(id int); INSERT INTO a VALUES ('secret-row'); COPY a FROM STDIN;\nCREATE TABLE false_table (secret text);\nsecret-copy-row\n\\.\nCREATE TABLE b(id int);"));
    expect(result.schemas[0].tables.map((table) => table.key.name)).toEqual(["a", "b"]);
    expect(JSON.stringify(result)).not.toMatch(/secret-row|secret-copy-row|false_table/); expect(result.coverage.skipped).toBe(2);
  });
  it.each(["CREATE PROCEDURE p() BEGIN CREATE TABLE false_table(id int); END; CREATE TABLE after_routine(id int);", "DELIMITER $$\nCREATE PROCEDURE p() BEGIN CREATE TABLE false_table(id int); END$$\nDELIMITER ;\nCREATE TABLE after_routine(id int);"])("never treats unsupported routine/delimiter contents as standalone tables", (tail) => {
    const result = parseDdl(ddlRequest(`CREATE TABLE before_routine(id int); ${tail}`, "mySql"));
    expect(result.schemas[0].tables.map((table) => table.key.name)).toEqual(["before_routine"]); expect(result.coverage.skipped).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/false_table|after_routine/);
  });
  it("ignores executable MySQL comments with a coverage warning", () => {
    const result = parseDdl(ddlRequest("/*! CREATE TABLE ghost(id int); */ CREATE TABLE real(id int);", "mySql"));
    expect(result.schemas[0].tables.map((table) => table.key.name)).toEqual(["real"]); expect(result.coverage.warnings).toBe(1);
  });
  it("supports PostgreSQL dollar strings, escaped quotes and nested comments without false splitting", () => {
    const result = parseDdl(ddlRequest("/* outer /* nested */ end */ CREATE TABLE t(id int, a text DEFAULT $q$a; b$q$, b text DEFAULT 'it''s; fine');"));
    expect(result.coverage.accepted).toBe(1); expect(result.schemas[0].tables[0].columns.map((column) => column.defaultValue)).toEqual([null, "'a; b'", "'it''s; fine'"]);
  });
  it.each(["CREATE TABLE bad(id int CHECK(id > 0));", "CREATE TABLE bad(id int GENERATED ALWAYS AS (1+2) STORED);", "CREATE TABLE bad(id int, FOREIGN KEY(id) REFERENCES missing);", "CREATE TABLE bad(id int, id text);", "CREATE TABLE bad(id int, PRIMARY KEY(missing));", "CREATE TABLE bad(id int) PARTITION BY RANGE(id);", "CREATE TABLE bad AS SELECT 1;", "CREATE TABLE bad(id int, PRIMARY KEY(id,id));"])("omits unsupported/invalid table definitions atomically and recovers for later statements: %s", (bad) => {
    const result = parseDdl(ddlRequest(`${bad}\nCREATE TABLE good(id int);`));
    expect(result.schemas[0].tables.map((table) => table.key.name)).toEqual(["good"]); expect(result.coverage).toMatchObject({ accepted: 1, skipped: 1, errors: 1 });
  });
  it("does not claim enforced MySQL FKs from inline REFERENCES", () => {
    const result = parseDdl(ddlRequest("CREATE TABLE t(id int REFERENCES p(id));", "mySql"));
    expect(result.schemas).toEqual([]); expect(result.diagnostics[0].message).toContain("not treated as an enforced foreign key");
  });
  it("resolves MySQL column references case-insensitively without folding table identities", () => {
    const result = parseDdl(ddlRequest("CREATE TABLE Parent(Id int PRIMARY KEY); CREATE TABLE child(id int, parent_id int, FOREIGN KEY(PARENT_ID) REFERENCES Parent(ID)); CREATE INDEX idx ON child(PARENT_ID);", "mySql"));
    expect(result.coverage).toMatchObject({ accepted: 3, errors: 0, warnings: 0 });
    const child = result.schemas[0].tables.find((table) => table.key.name === "child")!;
    expect(child.foreignKeys[0]).toMatchObject({ columns: ["parent_id"], referencedColumns: ["Id"], referencedTable: "Parent" }); expect(child.indexes[0].columns).toEqual(["parent_id"]);
  });
  it("marks unsupported CREATE/ALTER/VIEW/TYPE and index expressions rather than producing guessed objects", () => {
    const result = parseDdl(ddlRequest("CREATE VIEW v AS SELECT 1; CREATE TYPE mood AS ENUM('a'); ALTER TABLE t ADD x int; CREATE TABLE t(id int); CREATE INDEX bad_idx ON t((id+1));"));
    expect(result.coverage).toMatchObject({ accepted: 1, skipped: 4 }); expect(result.schemas[0].views).toEqual([]); expect(result.schemas[0].enums).toEqual([]); expect(result.schemas[0].tables[0].indexes).toEqual([]);
  });
  it("retains unresolved declared FK endpoints as information gaps and reports missing standalone index targets", () => {
    const result = parseDdl(ddlRequest("CREATE TABLE t(id int REFERENCES outside(id)); CREATE INDEX missing ON absent(id);"));
    expect(result.schemas[0].tables[0].foreignKeys).toHaveLength(1); expect(result.diagnostics.map((value) => value.code)).toContain("fk-target"); expect(result.coverage).toMatchObject({ accepted: 1, skipped: 1, warnings: 1 });
  });
  it("provides CRLF-aware source positions and keeps quoted dotted table identities separate", () => {
    const sql = '-- comment\r\nCREATE TABLE "a.b".c(id int);\r\nCREATE TABLE a."b.c"(id int);\r\nALTER TABLE x ADD y int;';
    const result = parseDdl(ddlRequest(sql)); expect(result.schemas).toHaveLength(2);
    expect(result.locations[0]).toMatchObject({ line: 2, column: 1 }); expect(result.diagnostics.find((value) => value.code === "unsupported-statement")).toMatchObject({ line: 4, column: 1 });
  });
  it("recovers previous complete statements from unterminated quotes and nesting exhaustion", () => {
    for (const tail of ["CREATE TABLE b(x text DEFAULT 'unterminated", `CREATE TABLE b(x int DEFAULT ${"(".repeat(65)}1`]) {
      const result = parseDdl(ddlRequest(`CREATE TABLE a(id int); ${tail}`)); expect(result.schemas[0].tables.map((table) => table.key.name)).toEqual(["a"]); expect(result.diagnostics.some((value) => value.code === "lexical")).toBe(true);
    }
  });
  it("rejects oversized UTF-8 input and missing namespace without allocating a model", () => {
    expect(() => parseDdl(ddlRequest("中".repeat(400_000)))).toThrow("1 MiB"); expect(() => parseDdl({ ...ddlRequest("CREATE TABLE t(id int);"), defaultSchema: " " })).toThrow("namespace");
  });
  it.each(["postgreSql", "mySql"] as const)("does not assume another dialect's identifier quoting in %s", (dialect) => {
    const sql = dialect === "postgreSql" ? "CREATE TABLE `t`(id int);" : 'CREATE TABLE "t"(id int);';
    const result = parseDdl(ddlRequest(sql, dialect)); expect(result.schemas).toEqual([]); expect(result.coverage.errors).toBe(1);
  });
  it("enforces the token budget without leaking rejected tokens or losing earlier complete declarations", () => {
    const compact = parseDdl(ddlRequest(`CREATE TABLE safe(id int); SELECT ${"x ".repeat(100_001)}`));
    expect(compact.diagnostics.some((value) => value.message.includes("Token limit"))).toBe(true); expect(compact.schemas[0].tables).toHaveLength(1);
  });
  it("retains at most 500 tables / 5,000 columns and marks excess objects", () => {
    const sql = Array.from({ length: 501 }, (_, index) => `CREATE TABLE t_${index}(${Array.from({ length: 10 }, (_, col) => `c${col} int`).join(",")});`).join("\n");
    const result = parseDdl(ddlRequest(sql)); expect(result.schemas[0].tables).toHaveLength(500); expect(result.coverage).toMatchObject({ accepted: 500, skipped: 1 });
  });
});
