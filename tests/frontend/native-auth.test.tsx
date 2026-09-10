// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const client = vi.hoisted(() => ({
  signIn: { email: vi.fn(), passkey: vi.fn() },
  passkey: { addPasskey: vi.fn(), deletePasskey: vi.fn() },
}));
vi.mock("better-auth/react", () => ({ createAuthClient: () => client }));
vi.mock("@better-auth/passkey/client", () => ({
  passkeyClient: () => ({ id: "passkey" }),
}));
import { NativeLogin } from "../../src/components/NativeLogin";
import { AccountSecurity } from "../../src/components/AccountSecurity";

const security = {
  email: "owner@example.com",
  passwordSet: false,
  passkeys: [],
  fresh: true,
  canRecover: false,
};
const password = "a long private passphrase";
beforeEach(() => {
  vi.clearAllMocks();
  client.signIn.email.mockResolvedValue({ data: {}, error: null });
  client.signIn.passkey.mockResolvedValue({ data: {}, error: null });
  client.passkey.addPasskey.mockResolvedValue({ data: {}, error: null });
  client.passkey.deletePasskey.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mockSecurity(value = security) {
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) =>
    Response.json(init?.method === "POST" ? { success: true } : value),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function fillPassword(value = password, confirm = value) {
  fireEvent.change(await screen.findByLabelText("New password"), {
    target: { value },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirm },
  });
}

describe("native sign-in", () => {
  it("signs in with email/password without storing credentials and clears the password", async () => {
    const ready = vi.fn(async () => {}),
      storage = vi.spyOn(Storage.prototype, "setItem");
    render(<NativeLogin accessRecovery={false} onAuthenticated={ready} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: password },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(client.signIn.email).toHaveBeenCalledWith({
      email: "owner@example.com",
      password,
    });
    expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
    expect(storage).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /GitHub/ })).toBeNull();
    expect(screen.queryByText(/sign up/i)).toBeNull();
  });
  it("offers passkey sign-in and configured GitHub sign-in, without requiring email", async () => {
    const ready = vi.fn(async () => {});
    render(<NativeLogin accessRecovery onAuthenticated={ready} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    );
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(client.signIn.passkey).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("link", { name: /GitHub/ }).getAttribute("href"),
    ).toBe("/api/auth/access");
  });
  it("keeps rejected credentials and provider errors out of the page and never opens a workspace", async () => {
    const ready = vi.fn(async () => {});
    client.signIn.email.mockResolvedValue({
      error: { status: 401, message: "sensitive backend detail" },
    });
    render(<NativeLogin accessRecovery={false} onAuthenticated={ready} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: password },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Email or password",
    );
    expect(screen.queryByText("sensitive backend detail")).toBeNull();
    expect(ready).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  });
  it("allows another attempt after a cancelled passkey prompt", async () => {
    client.signIn.passkey.mockRejectedValueOnce(
      new DOMException("secret", "NotAllowedError"),
    );
    render(
      <NativeLogin accessRecovery={false} onAuthenticated={async () => {}} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /cancelled|completed/,
    );
    expect(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    ).toHaveProperty("disabled", false);
  });
});

describe("account security", () => {
  it("offers GitHub setup when Access has not yet established a native account session", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
    render(<AccountSecurity accessRecovery onSignInAgain={async () => {}} />);
    const setup = await screen.findByRole("link", {
      name: "Set up sign-in with GitHub",
    });
    expect(setup.getAttribute("href")).toBe("/api/auth/access");
    expect(screen.queryByLabelText("New password")).toBeNull();
  });
  it("requires 15 characters before requesting a password change", async () => {
    const fetcher = mockSecurity();
    render(
      <AccountSecurity accessRecovery={false} onSignInAgain={async () => {}} />,
    );
    await fillPassword("too short");
    fireEvent.submit(screen.getByRole("form", { name: "Manage password" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "15 and 128",
    );
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(
      false,
    );
  });
  it("sets a replacement password only through a verified passkey recovery session", async () => {
    const fetcher = mockSecurity({
      ...security,
      passwordSet: true,
      canRecover: true,
    });
    render(<AccountSecurity accessRecovery onSignInAgain={async () => {}} />);
    await fillPassword();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /without the current password/ }),
    );
    expect(screen.queryByLabelText("Current password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set a new password" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) => call[0] === "/api/auth/recover-password",
        ),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        fetcher.mock.calls.find(
          (call) => call[0] === "/api/auth/recover-password",
        )![1]!.body as string,
      ),
    ).toEqual({ newPassword: password });
  });
  it("does not reuse recovery authority if the fresh security check revokes it", async () => {
    let reads = 0;
    const fetcher = vi.fn(async () =>
      Response.json({
        ...security,
        passwordSet: true,
        canRecover: ++reads === 1,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<AccountSecurity accessRecovery onSignInAgain={async () => {}} />);
    await fillPassword();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /without the current password/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Set a new password" }));
    await screen.findByRole("alert");
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(
      false,
    );
  });
  it("checks password confirmation before setting the first password and clears fields afterward", async () => {
    const fetcher = mockSecurity();
    render(
      <AccountSecurity accessRecovery={false} onSignInAgain={async () => {}} />,
    );
    await fillPassword(password, "different long passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("alert")).textContent).toContain("match");
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(
      false,
    );
    await fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await screen.findByRole("status");
    const call = fetcher.mock.calls.find(
      (call) => call[0] === "/api/auth/set-password",
    )!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      newPassword: password,
    });
    expect(screen.getByLabelText("New password")).toHaveProperty("value", "");
  });
  it("changes an existing password with the old password and revokes other sessions", async () => {
    const fetcher = mockSecurity({ ...security, passwordSet: true });
    render(
      <AccountSecurity accessRecovery={false} onSignInAgain={async () => {}} />,
    );
    await fillPassword();
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "current private password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) => call[0] === "/api/auth/change-password",
        ),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        fetcher.mock.calls.find(
          (call) => call[0] === "/api/auth/change-password",
        )![1]!.body as string,
      ),
    ).toEqual({
      currentPassword: "current private password",
      newPassword: password,
      revokeOtherSessions: true,
    });
  });
  it("reports a saved password even if the following settings refresh fails", async () => {
    let saved = false;
    vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        saved = true;
        return Response.json({ success: true });
      }
      return saved
        ? new Response(null, { status: 503 })
        : Response.json(security);
    });
    render(
      <AccountSecurity accessRecovery={false} onSignInAgain={async () => {}} />,
    );
    await fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Password set.",
    );
    expect(screen.getByRole("alert").textContent).toMatch(/saved.*refresh/i);
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });
  it("disables credential changes until an expired session signs in again", async () => {
    mockSecurity({ ...security, fresh: false });
    const again = vi.fn(async () => {});
    render(<AccountSecurity accessRecovery onSignInAgain={again} />);
    await screen.findByText(/Sign in again before changing/i);
    expect(screen.getByRole("button", { name: "Set password" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Add passkey" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(again).toHaveBeenCalledOnce();
    expect(client.passkey.addPasskey).not.toHaveBeenCalled();
  });
  it("checks freshness immediately before invoking the browser's passkey enrollment", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", async () =>
      Response.json({ ...security, fresh: ++reads === 1 }),
    );
    render(
      <AccountSecurity accessRecovery={false} onSignInAgain={async () => {}} />,
    );
    fireEvent.change(await screen.findByLabelText("Passkey name"), {
      target: { value: "MacBook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    await screen.findByText(/Sign in again before changing/i);
    expect(client.passkey.addPasskey).not.toHaveBeenCalled();
  });
  it("offers explicit Access sign-out only for expired first-time enrollment", async () => {
    mockSecurity({
      ...security,
      fresh: false,
      enrollmentPending: true,
    } as typeof security);
    render(<AccountSecurity accessRecovery onSignInAgain={async () => {}} />);
    const logout = await screen.findByRole("link", {
      name: "Sign out of Cloudflare Access",
    });
    expect(logout.getAttribute("href")).toBe("/cdn-cgi/access/logout");
    expect(
      screen.getByText(/also signs you out of other Access apps/),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });
  it("adds a named passkey and requires confirmation to remove an existing key", async () => {
    mockSecurity({
      ...security,
      passwordSet: true,
      passkeys: [
        { id: "key-1", name: "My phone", createdAt: "2026-09-09T00:00:00Z" },
      ],
    } as typeof security);
    render(
      <AccountSecurity accessRecovery={false} onSignInAgain={async () => {}} />,
    );
    fireEvent.change(await screen.findByLabelText("Passkey name"), {
      target: { value: "MacBook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    await waitFor(() =>
      expect(client.passkey.addPasskey).toHaveBeenCalledWith({
        name: "MacBook",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove My phone" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove My phone" }));
    expect(client.passkey.deletePasskey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() =>
      expect(client.passkey.deletePasskey).toHaveBeenCalledWith({
        id: "key-1",
      }),
    );
  });
});
