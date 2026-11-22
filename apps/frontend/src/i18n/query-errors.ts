import type { QueryErrorKind } from "../platform";
import type { Translate } from "./index";
import type { MessageKey } from "./messages";

export const queryErrorMessages = {
  "validation": "queryErrors.validation",
  "unsupported": "queryErrors.unsupported",
  "connection": "queryErrors.connection",
  "timeout": "queryErrors.timeout",
  "cancelled": "queryErrors.cancelled",
  "database": "queryErrors.database",
  "resultLimit": "queryErrors.resultLimit",
  "unsupportedType": "queryErrors.unsupportedType",
  "internal": "queryErrors.internal"
} as const satisfies Record<QueryErrorKind, MessageKey>;

export function normalizeQueryError(t: Translate, error: unknown): { kind: QueryErrorKind; message: string } {
  if (typeof error === "object" && error && "kind" in error && "message" in error) {
    const kind = String(error.kind);
    return { kind: Object.hasOwn(queryErrorMessages, kind) ? kind as QueryErrorKind : "internal", message: String(error.message) };
  }
  if (typeof error === "string") {
    try { return normalizeQueryError(t, JSON.parse(error)); } catch { return { kind: "internal", message: error }; }
  }
  return { kind: "internal", message: error instanceof Error ? error.message : t("business.queryExecutionFailed") };
}
