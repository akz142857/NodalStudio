export interface PurchaseStatus {
  distribution: "community" | "macAppStore";
  state: "community" | "checking" | "verified" | "needsRecovery" | "unverified" | "unsupported";
  reason: string | null;
  environment: string | null;
  checkedAt: string | null;
  canUsePaidFeatures: boolean;
  busy: boolean;
}
