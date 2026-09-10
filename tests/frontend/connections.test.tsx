// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Connections } from "../../src/components/Connections";
afterEach(cleanup);
function fixture() {
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/messaging/plugins")
      return {
        plugins: [{ id: "telegram", label: "Telegram", configured: true }],
      };
    if (path === "/api/messaging/links") return { links: [] };
    if (path === "/api/messaging/deliveries") return { deliveries: [] };
    if (path === "/api/messaging/link-codes")
      return {
        instruction: "Send /start LINK_CODE in a private chat with the bot.",
        expiresAt: Date.now() + 600000,
      };
    if (path === "/api/devices/enrollment")
      return { code: "PAIR_CODE", expires_at: Date.now() + 600000 };
    if (path === "/api/devices")
      return {
        devices: [
          {
            device_id: "device-1",
            name: "My Mac",
            revoked_at: null,
            last_seen_at: null,
          },
        ],
      };
    if (path === "/api/devices/jobs")
      return {
        jobs: [
          {
            job_id: "job-1",
            device_id: "device-1",
            command: "pwd",
            cwd: "/tmp",
            status: "completed",
            created_at: Date.now(),
            result_summary: { exit_code: 0 },
          },
        ],
      };
    if (path === "/api/devices/jobs/job-1")
      return {
        job: { result: { stdout: "/private/tmp", stderr: "", exit_code: 0 } },
      };
    return { ok: true };
  });
  render(<Connections api={api} conversationId="current-conversation" />);
  return api;
}
describe("connection management", () => {
  it("creates an enrollment code and revokes the selected device", async () => {
    const api = fixture();
    await screen.findByText("My Mac");
    fireEvent.change(screen.getByLabelText("Device name"), {
      target: { value: "Laptop" },
    });
    fireEvent.click(screen.getByText("Create pairing code"));
    await screen.findByText("PAIR_CODE");
    expect(api).toHaveBeenCalledWith(
      "/api/devices/enrollment",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Laptop" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke My Mac" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/devices/device-1", {
        method: "DELETE",
      }),
    );
  });
  it("links Telegram to the currently selected conversation", async () => {
    const api = fixture();
    fireEvent.click(
      await screen.findByRole("button", { name: "Link Telegram" }),
    );
    await screen.findByText(
      "Send /start LINK_CODE in a private chat with the bot.",
    );
    expect(api).toHaveBeenCalledWith(
      "/api/messaging/link-codes",
      expect.objectContaining({
        body: JSON.stringify({
          pluginId: "telegram",
          conversationId: "current-conversation",
        }),
      }),
    );
  });
  it("loads command output individually from metadata history", async () => {
    const api = fixture();
    fireEvent.click(await screen.findByText("Load command output"));
    await screen.findByText("/private/tmp");
    expect(api).toHaveBeenCalledWith("/api/devices/jobs/job-1");
  });
});
