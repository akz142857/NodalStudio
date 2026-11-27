import { describe, expect, it } from "vitest";
import { classifySqlExecution, currentSqlStatement, validateSqlText, currentPostgresStatement, validatePostgresSqlText } from "./sql-validation";

describe("PostgreSQL syntax validation", () => {
  it("accepts a complete select and reports an incomplete expression", () => {
    expect(validatePostgresSqlText("SELECT id FROM public.users WHERE active = true;")).toEqual([]);
    expect(validatePostgresSqlText("SELECT (")).not.toEqual([]);
  });
});

describe("current statement execution", () => {
  it("uses the cursor statement, including a final statement without a delimiter", () => {
    const sql = "SELECT 1;\n\nSELECT 2";
    expect(currentPostgresStatement(sql, 3)).toBe("SELECT 1;");
    expect(currentPostgresStatement(sql, sql.indexOf("2"))).toBe("SELECT 2");
    expect(currentPostgresStatement(sql, sql.length)).toBe("SELECT 2");
    expect(currentPostgresStatement(" -- no SQL;\n/* yet; */", 10)).toBe("");
  });
  it.each([
    "SELECT 'value; still one';",
    'SELECT "semi;colon" FROM public.t;',
    "SELECT $$dollar;literal$$;",
    "SELECT $tag$dollar;literal$tag$;",
    "SELECT E'escaped\\'; still one';",
    "SELECT 1 /* outer; /* inner; */ end; */;",
    "SELECT 1 -- comment;\n + 2;",
  ])("keeps a complete statement with embedded delimiters: %s", (first) => {
    const sql = `${first}\nSELECT 9;`;
    expect(currentPostgresStatement(sql, 4)).toBe(first);
    expect(currentPostgresStatement(sql, sql.indexOf("9"))).toBe("SELECT 9;");
  });
});


describe("MySQL lexical boundaries", () => {
  it.each(["SELECT `semi;colon` FROM `order``item`;", "SELECT 'escaped\\';still one';", "SELECT 1 # comment;\n + 2;"])("keeps literals, quoted names and comments together: %s", (first) => {
    const sql = `${first}\nSELECT 9;`;
    expect(currentSqlStatement(sql, 1, "mySql")).toBe(first);
    expect(currentSqlStatement(sql, sql.indexOf("9"), "mySql")).toBe("SELECT 9;");
    expect(validateSqlText(first, "mySql")).toEqual([]);
  });
});

it("uses SQLite lexical boundaries for quoted identifiers and accepts SQLite expressions", () => {
  const text = "SELECT [a;b], 'x;y' FROM main.t; SELECT json_extract('{}', '$.x');";
  expect(currentSqlStatement(text, 5, "sqlite")).toBe("SELECT [a;b], 'x;y' FROM main.t;");
  expect(validateSqlText("SELECT strftime('%Y', 'now'), 1 || 'x'", "sqlite")).toEqual([]);
});

describe("Query editor execution routing", () => {
  it.each([
    ["-- structure change\nALTER TABLE `app`.`orders` ADD COLUMN tag BIGINT COMMENT 'example; note', ADD KEY idx_tag (tag);", "ddl"],
    ["CREATE UNIQUE INDEX idx_tag ON orders (tag);", "ddl"],
    ["DROP INDEX idx_tag ON orders;", "ddl"],
    ["SELECT 'one;two'; -- trailing comment;", "query"],
    ["WITH ids AS (SELECT 1) SELECT * FROM ids;", "query"],
    ["(SELECT 1) UNION ALL SELECT 2;", "query"],
    ["WITH ids AS (SELECT 1) UPDATE orders SET id = 0;", "unsupported"],
    ["UPDATE orders SET tag = 0;", "unsupported"],
    ["CREATE VIEW example AS SELECT 1;", "unsupported"],
    ["SELECT 1; ALTER TABLE orders ADD COLUMN tag INT;", "multiple"],
    [";; -- no statement;\n/* nor here; */", "empty"],
  ])("classifies %s as %s", (sql, expected) => {
    expect(classifySqlExecution(sql, "mySql")).toBe(expected);
  });
});
