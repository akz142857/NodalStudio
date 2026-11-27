export function extensionErrorMessage(error: unknown) {
  switch (String(error)) {
    case "extensionInvalid": return "codeReview.extensions.invalid";
    case "extensionLimit": return "codeReview.extensions.limit";
    case "extensionAlreadyInstalled": return "codeReview.extensions.duplicate";
    case "extensionUnsupported": return "codeReview.extensions.unsupported";
    case "extensionChanged": return "codeReview.extensions.changed";
    case "openVsxOffline": return "codeReview.extensions.marketOffline";
    case "openVsxNetwork": return "codeReview.extensions.marketNetwork";
    case "openVsxResponse": return "codeReview.extensions.marketResponse";
    case "openVsxUnavailable": return "codeReview.extensions.marketUnavailable";
    case "openVsxIntegrity": return "codeReview.extensions.marketIntegrity";
    default: return "codeReview.extensions.storage";
  }
}
