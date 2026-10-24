import type { QueryErrorKind } from "../platform";
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
