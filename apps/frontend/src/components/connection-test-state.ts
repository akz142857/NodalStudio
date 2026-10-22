import type { ConnectionTestResult, ConnectionTestProgress } from "../platform";

export interface ConnectionFailure {
  stage: "configuration" | "ssh" | "tls" | "database" | "cancelled" | "timeout";
  message: string;
  sshConnected: boolean;
}
export type ConnectionTestState =
  | { status: "idle" }
  | { status: "testing" | "cancelled"; progress?: ConnectionTestProgress; cancelling?: boolean }
  | { status: "success"; result: ConnectionTestResult }
  | { status: "error"; failure: ConnectionFailure; progress?: ConnectionTestProgress };
export function connectionFailure(reason: unknown): ConnectionFailure {
  if (typeof reason === "object" && reason !== null && "stage" in reason && "message" in reason && typeof reason.message === "string" && ["configuration", "ssh", "tls", "database", "cancelled", "timeout"].includes(String(reason.stage))) {
    return { stage: reason.stage as ConnectionFailure["stage"], message: reason.message, sshConnected: "sshConnected" in reason && reason.sshConnected === true };
  }
  return { stage: "configuration", message: reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Connection test failed. Try again.", sshConnected: false };
}
