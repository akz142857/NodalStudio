import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConnectionTestStatus } from "./ConnectionTestStatus";
import { connectionFailure } from "./connection-test-state";
import type { SaveDataSourceInput } from "../platform";
afterEach(cleanup);
const form: SaveDataSourceInput = {
  displayName: "Fixture", host: "localhost", port: 5432, database: "app", username: "user", password: "fixture",
  databaseType: "postgreSql", sslMode: "prefer", security: { tls: {}, ssh: { host: "jump", port: 22, username: "user", authentication: "password" } },
};
it("shows a continuous SSH-to-server route and reports disabled TLS separately", () => {
  render(<ConnectionTestStatus form={{ ...form, databaseType: "mySql", database: "", sslMode: "disable" }} state={{ status: "success", result: { database: { name: "", databaseType: "mySql", version: "8.4" }, sslActive: false, serverReadOnly: false } }} />);
  const route = within(screen.getByRole("list"));
  const nodes = route.getAllByRole("listitem");
  expect(nodes).toHaveLength(2);
  expect(within(nodes[0]).getByRole("group", { name: "SSH status" })).toHaveTextContent("Connected");
  expect(within(nodes[1]).getByRole("group", { name: "Server status" })).toHaveTextContent("Connected");
  for (const node of nodes) expect(node).toHaveAttribute("data-tone", "success");
  expect(route.queryByRole("group", { name: "TLS status" })).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "TLS status" })).toHaveTextContent("TLS Not enabled");
  expect(screen.getByRole("status")).toHaveTextContent("Server connected");
});
it("does not claim TLS passed when Prefer falls back to plaintext", () => {
  render(<ConnectionTestStatus form={form} state={{ status: "success", result: { database: { name: "app", databaseType: "postgreSql", version: "16" }, sslActive: false, serverReadOnly: false } }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Not encrypted");
  expect(screen.getByRole("status")).toHaveTextContent("Choose Require or Verify full");
  expect(within(screen.getByRole("list")).getByRole("group", { name: "TLS status" })).toHaveTextContent("Not encrypted");
});
it("guides the user to TLS when PostgreSQL rejects an unencrypted connection", () => {
  render(<ConnectionTestStatus form={{ ...form, sslMode: "disable" }} state={{ status: "error", failure: {
    stage: "tls", code: "unencryptedConnectionRejected", message: "Native fallback", sshConnected: true,
  } }} />);
  const result = within(screen.getByRole("alert"));
  expect(result.getByText("Unencrypted connection rejected")).toBeVisible();
  expect(result.getByText(/Choose Require or Verify full in the TLS tab/)).toBeVisible();
  expect(result.getByRole("group", { name: "SSH status" })).toHaveTextContent("Connected");
  expect(result.getByRole("group", { name: "TLS status" })).toHaveTextContent("Not enabled");
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
it("reports missing App Store host authorization as configuration with SSH still untested", () => {
  const failure = connectionFailure({
    stage: "configuration", code: "sshKnownHostsRequired", message: "Native fallback message", sshConnected: false,
  });
  render(<ConnectionTestStatus form={form} state={{ status: "error", failure }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Check connection settings");
  expect(screen.getByRole("alert")).toHaveTextContent("In the SSH tab, use Choose to authorize a trusted known_hosts file");
  expect(screen.getByRole("group", { name: "SSH status" })).toHaveTextContent("Not tested");
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

it("presents a SQLite file failure without an unrelated not-tested network checklist", () => {
  render(<ConnectionTestStatus form={{ ...form, databaseType: "sqlite" }} state={{ status: "error", failure: { stage: "file", message: "Choose a readable SQLite file.", sshConnected: false } }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Unable to open SQLite file");
  expect(screen.getByRole("alert")).toHaveTextContent("Choose a readable SQLite file.");
  expect(screen.queryByText("Not tested")).not.toBeInTheDocument();
  expect(screen.queryByRole("group")).not.toBeInTheDocument();
});
