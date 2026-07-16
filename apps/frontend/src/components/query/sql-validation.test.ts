import { describe, expect, it } from "vitest";
import { validatePostgresSqlText } from "./sql-validation";

describe("PostgreSQL syntax validation", () => {
  it("accepts a complete select and reports an incomplete expression", () => {
    expect(validatePostgresSqlText("SELECT id FROM public.users WHERE active = true;")).toEqual([]);
    expect(validatePostgresSqlText("SELECT (")).not.toEqual([]);
  });
});
