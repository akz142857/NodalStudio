const syncErrors = {
  passphraseLength: "connectionSync.passphraseLength",
  noConnections: "connectionSync.noConnections",
  invalidFile: "connectionSync.invalidFile",
  unsupportedVersion: "connectionSync.unsupportedVersion",
  cannotDecrypt: "connectionSync.cannotDecrypt",
  cannotRead: "connectionSync.cannotRead",
  cannotWrite: "connectionSync.cannotWrite",
  invalidSelection: "connectionSync.invalidSelection",
  tooLarge: "connectionSync.tooLarge",
  stalePreview: "connectionSync.stalePreview",
  unavailable: "connectionSync.unavailable",
  busy: "connectionFolder.busy",
  folderWaiting: "connectionFolder.waiting",
  folderChanged: "connectionFolder.folderChanged",
  chooseLibrary: "connectionFolder.chooseLibrary",
  locked: "connectionFolder.locked",
  offline: "connectionFolder.offline",
  paused: "connectionFolder.paused",
} as const;

export type ConnectionSyncErrorMessage = (typeof syncErrors)[keyof typeof syncErrors];

export function connectionSyncError(reason: unknown): ConnectionSyncErrorMessage {
  return typeof reason === "string" && Object.hasOwn(syncErrors, reason)
    ? syncErrors[reason as keyof typeof syncErrors]
    : syncErrors.unavailable;
}

export function isValidSyncPassphrase(passphrase: string): boolean {
  return Array.from(passphrase).length >= 12 && new TextEncoder().encode(passphrase).length <= 1024 && Boolean(passphrase.trim());
}
