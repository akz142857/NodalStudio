/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDdlPreview, ddlDiagramSnapshot } from "./ddl-preview";
import type { DdlRequest } from "./ddl-types";
const request: DdlRequest = { text: "CREATE TABLE t(id INTEGER PRIMARY KEY);", dialect: "postgreSql", defaultSchema: "public", source: { kind: "ddl-file", name: "/private/schema.sql", id: "session" } };
describe("temporary DDL identity", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto)); afterEach(() => vi.unstubAllGlobals());
  it("separates content hash, parsed fingerprint and session identity from database captures", async () => {
    const a = await createDdlPreview(request); const b = await createDdlPreview({ ...request, text: "-- comment\n CREATE TABLE t ( id integer PRIMARY KEY ) ; INSERT INTO t VALUES ('secret');", source: { kind: "ddl-clipboard", name: "Clipboard", id: "another" } });
    expect(a.fingerprint).toBe(b.fingerprint); expect(a.source.contentHash).not.toBe(b.source.contentHash); expect(a.source.id).not.toBe(b.source.id);
    expect(a.source.name).toBe("schema.sql"); expect(a.fingerprint).toMatch(/^ddl-preview-v1:[a-f0-9]{64}$/);
    expect(JSON.stringify(b)).not.toContain("secret"); expect(ddlDiagramSnapshot(a).sourceId).toBe("ddl-preview:session"); expect(ddlDiagramSnapshot(a).capturedAt).toContain("not a database capture");
  });
  it("changes the model identity when dialect, namespace or parsed structure changes", async () => {
    const base = await createDdlPreview(request);
    for (const change of [{ dialect: "mySql" as const }, { defaultSchema: "other" }, { text: "CREATE TABLE t(id integer, extra text);" }]) expect((await createDdlPreview({ ...request, ...change })).fingerprint).not.toBe(base.fingerprint);
  });
});
