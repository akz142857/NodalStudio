import type { MessageKey, Translate } from "./messages";
const messages = {
  "passwordRequired": "connectionErrors.passwordRequired",
  "tlsHandshake": "connectionErrors.tlsHandshake",
  "authenticationRejected": "connectionErrors.authenticationRejected",
  "databaseMissing": "connectionErrors.databaseMissing",
  "permissionDenied": "connectionErrors.permissionDenied",
  "requestRejected": "connectionErrors.requestRejected",
  "unreachable": "connectionErrors.unreachable",
  "identityUnavailable": "connectionErrors.identityUnavailable"
} as const satisfies Record<string, MessageKey>;
/** Only structured application codes are translated; unknown diagnostics stay intact. */
export function translateConnectionFailure(failure: { code?: string; message: string }, t: Translate) {
  const key = failure.code && Object.hasOwn(messages, failure.code) ? messages[failure.code as keyof typeof messages] : undefined;
  return key ? t(key) : failure.message;
}
