import type { DatabaseSnapshot } from "../platform/types";
import { parseDdl } from "./ddl-parser";
import type { DdlPreview, DdlRequest } from "./ddl-types";
async function digest(value: string) { if (!crypto.subtle) throw new Error("Web Crypto SHA-256 is unavailable. Use a secure/local compatible runtime for DDL preview."); const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function createDdlPreview(request: DdlRequest): Promise<DdlPreview> {
  const defaultSchema = request.defaultSchema.trim();
  const parsed = parseDdl({ ...request, defaultSchema });
  const [contentHash, fingerprint] = await Promise.all([digest(request.text), digest(JSON.stringify(["ddl-preview-v1", request.dialect, defaultSchema, parsed.schemas]))]);
  return { ...parsed, dialect: request.dialect, defaultSchema, fingerprint: `ddl-preview-v1:${fingerprint}`, source: { kind: request.source.kind, name: request.source.name.split(/[\\/]/u).at(-1)!.slice(0, 256), id: `ddl-preview:${request.source.id}`, contentHash: `sha256:${contentHash}` } };
}
/** A rendering projection only; never handed to capture/history/storage/cloud APIs. */
export function ddlDiagramSnapshot(preview: DdlPreview): DatabaseSnapshot {
  return { id: `${preview.source.id}:render`, sourceId: preview.source.id, capturedAt: "DDL preview — not a database capture", fingerprint: preview.fingerprint,
    database: { name: preview.source.name, databaseType: preview.dialect, version: "DDL source; server version unknown" }, schemas: preview.schemas };
}
