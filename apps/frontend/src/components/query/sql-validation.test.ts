import { describe, expect, it } from "vitest";
import { currentSqlStatement, validateSqlText, currentPostgresStatement, validatePostgresSqlText } from "./sql-validation";

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
