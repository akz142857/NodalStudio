import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionSecurity, NodalStudioPlatform } from "../platform";
import { ConnectionSecurityFields } from "./ConnectionSecurityFields";

describe("connection security", () => {
  it("keeps TLS identity while toggling SSH, and uses the local file picker", async () => {
    const changed = vi.fn();
    const platform = { pickConnectionFile: vi.fn().mockResolvedValue("/certs/root.pem") } as unknown as NodalStudioPlatform;
    function Form() {
      const [security, setSecurity] = useState<ConnectionSecurity>({ tls: {} });
      return <ConnectionSecurityFields security={security} sslMode="verifyFull" disabled={false} platform={platform} onChange={(next) => { setSecurity(next); changed(next); }} />;
    }
    render(<Form />);
    fireEvent.click(screen.getByText("Certificates"));
    fireEvent.click(screen.getByRole("button", { name: "Choose ca certificate" }));
    await waitFor(() => expect(screen.getByLabelText("CA certificate")).toHaveValue("/certs/root.pem"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
    const identity = screen.getByRole("region", { name: "Server identity" });
    expect(identity.closest("details")).toBeNull();
    expect(screen.getByLabelText("Known hosts file")).toBeVisible();
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "jump.example.com" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "privateKey" } });
    expect(screen.getByLabelText("SSH private key")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
    expect(changed).toHaveBeenLastCalledWith({ tls: { caCertificate: "/certs/root.pem" }, ssh: null });
  });
  it("hides inactive TLS fields and disables edits during a connection", () => {
    render(<ConnectionSecurityFields sslMode="disable" disabled platform={{} as NodalStudioPlatform} onChange={vi.fn()} />);
    expect(screen.queryByText("Certificates")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});

it("shows the required App Store host file without opening a disclosure and authorizes it through the picker", async () => {
  const changed = vi.fn<(security: ConnectionSecurity) => void>();
  const getRuntimeInfo = vi.fn().mockResolvedValue({ distribution: "macAppStore" });
  const pickConnectionFile = vi.fn().mockResolvedValue("/trusted/known_hosts");
  const platform = { getRuntimeInfo, pickConnectionFile } as unknown as NodalStudioPlatform;
  function Form() { const [security,setSecurity]=useState<ConnectionSecurity>({tls:{}}); return <ConnectionSecurityFields security={security} sslMode="disable" disabled={false} platform={platform} onChange={value=>{setSecurity(value);changed(value);}} />; }
  render(<Form />);
  await waitFor(()=>expect(getRuntimeInfo).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(()=>expect(screen.getByLabelText("Authentication")).toHaveValue("privateKey"));
  expect(screen.getByRole("option",{name:/SSH agent/i})).toBeDisabled();
  const knownHosts = screen.getByLabelText("Known hosts file (required)");
  expect(knownHosts).toBeVisible();
  expect(knownHosts).toHaveAccessibleDescription(/already trusts this jump host/);
  fireEvent.click(screen.getByRole("button", { name: "Choose known hosts file (required)" }));
  await waitFor(() => expect(knownHosts).toHaveValue("/trusted/known_hosts"));
  expect(pickConnectionFile).toHaveBeenCalledOnce();
  expect(changed.mock.lastCall?.[0].ssh?.knownHosts).toBe("/trusted/known_hosts");
});
