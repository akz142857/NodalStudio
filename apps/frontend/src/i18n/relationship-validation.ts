import type { MessageKey, Translate } from "./messages";
const messages = {
  "fieldCount": "relationshipValidation.fieldCount",
  "selfReference": "relationshipValidation.selfReference",
  "missingField": "relationshipValidation.missingField",
  "typeMismatch": "relationshipValidation.typeMismatch",
  "physicalExists": "relationshipValidation.physicalExists",
  "duplicate": "relationshipValidation.duplicate"
} as const satisfies Record<string, MessageKey>;
export function translateRelationshipValidation(message: string, code: string | undefined, t: Translate) {
 const key = code && Object.hasOwn(messages, code) ? messages[code as keyof typeof messages] : undefined;
 return key ? t(key) : message;
}
