import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConnectionTestStatus } from "./ConnectionTestStatus";
import { connectionFailure } from "./connection-test-state";
import type { SaveDataSourceInput } from "../platform";
afterEach(cleanup);
const form = { sslMode: "prefer", security: { ssh: { host: "jump", port: 22, username: "user", authentication: "password" } } } as SaveDataSourceInput;
it("does not claim TLS passed when Prefer falls back to plaintext", () => {
  render(<ConnectionTestStatus form={form} state={{ status: "success", result: { database: { name: "app", databaseType: "postgreSql", version: "16" }, sslActive: false, serverReadOnly: false } }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Not encrypted");
  expect(screen.getByRole("status")).toHaveTextContent("Choose Require or Verify full");
});
it("keeps successful SSH visible when database authentication fails", () => {
  render(<ConnectionTestStatus form={form} state={{ status: "error", failure: { stage: "database", message: "Authentication rejected", sshConnected: true } }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("SSHConnected");
  expect(screen.getByRole("alert")).toHaveTextContent("TLSNot verified");
});
it("handles structured native errors and plain platform errors", () => {
  expect(connectionFailure({ stage: "ssh", message: "Unknown host key", sshConnected: false }).stage).toBe("ssh");
  expect(connectionFailure(new Error("Unavailable")).message).toBe("Unavailable");
});
it("shows separate checks and truthful indeterminate progress", () => {
  render(<ConnectionTestStatus form={form} onCancel={() => {}} state={{ status: "testing", progress: { phase: "handshake", sshConnected: true } }} />);
  expect(screen.getByRole("group", { name: "SSH status" })).toHaveTextContent("Connected");
  expect(screen.getByRole("group", { name: "TLS status" })).toHaveTextContent("Negotiating");
  expect(screen.getByRole("group", { name: "Database status" })).toHaveTextContent("Connecting");
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  expect(screen.getByRole("button", { name: "Cancel connection test" })).toBeEnabled();
});
it("preserves finished SSH after cancellation without marking TLS successful", () => {
  render(<ConnectionTestStatus form={form} state={{ status: "cancelled", progress: { phase: "handshake", sshConnected: true } }} />);
  expect(screen.getByRole("group", { name: "SSH status" })).toHaveTextContent("Connected");
  expect(screen.getByRole("group", { name: "TLS status" })).toHaveTextContent("Not verified");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});
