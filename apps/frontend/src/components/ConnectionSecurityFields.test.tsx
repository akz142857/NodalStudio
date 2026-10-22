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
