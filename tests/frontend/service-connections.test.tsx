// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ServiceConnections } from "../../src/components/ServiceConnections";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const connected = {
  id: "connection/1",
  provider: "google",
  account: "owner@example.com",
  status: "connected" as const,
  created_at: Date.now(),
  services: ["gmail", "calendar"],
};
const authorization_url =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=example&state=expected-state";
function page(connections: object[] = [], configured = true) {
  return {
    configured,
    plugins: [
      {
        id: "google",
        label: "Google Workspace",
        description: "Read and manage your Google services in the cloud.",
      },
    ],
    services: [
      { id: "gmail", label: "Gmail", scopes: ["https://mail.google.com/"] },
      {
        id: "calendar",
        label: "Calendar",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
      {
        id: "drive",
        label: "Drive",
        scopes: ["https://www.googleapis.com/auth/drive"],
      },
      {
        id: "chat",
        label: "Google Chat",
        scopes: ["https://www.googleapis.com/auth/chat.messages"],
        requires_workspace: true,
      },
    ],
    connections,
  };
}
function popupFixture() {
  const popup = {
    location: { assign: vi.fn() },
    closed: false,
    close: vi.fn(),
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  return popup;
}
function relay(
  popup: ReturnType<typeof popupFixture>,
  data: unknown,
  origin = window.location.origin,
) {
  fireEvent(
    window,
    new MessageEvent("message", {
      source: popup as unknown as Window,
      origin,
      data,
    }),
  );
}
function oauthApi() {
  return vi.fn(async (path: string) => {
    if (path === "/api/connectors/google/connect")
      return { authorization_url, expires_at: Date.now() + 600000 };
    if (path === "/api/connectors/google/callback")
      return { connected: true, connection_id: "connection/1" };
    return page();
  });
}

describe("external service connections", () => {
  it("disables Keep until the operator configures Workspace delegation", async () => {
    const result = page();
    const api = vi.fn(async () => ({
      ...result,
      services: [
        ...result.services,
        {
          id: "keep",
          label: "Google Keep",
          scopes: [],
          authorization: "workspace-delegation",
          available: false,
          description:
            "The workspace operator must configure Google Keep delegation.",
        },
      ],
    }));
    render(<ServiceConnections api={api} />);
    const keep = await screen.findByRole("checkbox", { name: "Google Keep" });
    expect((keep as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "The workspace operator must configure Google Keep delegation.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Gmail" }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });

  it("requests only the services selected by the user and defaults to Gmail", async () => {
    const popup = popupFixture();
    const api = oauthApi();
    render(<ServiceConnections api={api} />);
    const gmail = await screen.findByRole("checkbox", { name: "Gmail" });
    expect((gmail as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: "Calendar" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: "Drive" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Calendar" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Drive" }));
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Google Workspace" }),
    );
    await waitFor(() => expect(popup.location.assign).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/api/connectors/google/connect", {
      method: "POST",
      body: JSON.stringify({ services: ["gmail", "calendar", "drive"] }),
    });
    expect(gmail.hasAttribute("disabled")).toBe(true);
  });

  it("requires at least one service and explains Workspace requirements", async () => {
    const api = oauthApi();
    render(<ServiceConnections api={api} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Gmail" }));
    expect(
      screen
        .getByRole("button", { name: "Connect Google Workspace" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText("Select at least one service to connect."),
    ).toBeTruthy();
    expect(
      screen.getByText("Requires a Google Workspace account."),
    ).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("shows connected service labels and leaves newly available services unselected", async () => {
    let refreshed = false;
    const api = vi.fn(async () => {
      const result = page([connected]);
      if (refreshed)
        result.services.push({
          id: "tasks",
          label: "Tasks",
          scopes: ["https://www.googleapis.com/auth/tasks"],
        });
      return result;
    });
    render(<ServiceConnections api={api} />);
    await screen.findByText("Services: Gmail, Calendar");
    refreshed = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh services" }));
    expect(
      (
        (await screen.findByRole("checkbox", {
          name: "Tasks",
        })) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: "Gmail" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(api.mock.calls).toHaveLength(2);
  });

  it("loads available services and explains Gmail access", async () => {
    let resolve!: (value: unknown) => void;
    const api = vi.fn(() => new Promise((done) => (resolve = done)));
    render(<ServiceConnections api={api} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(
      screen
        .getByRole("button", { name: "Refresh services" })
        .hasAttribute("disabled"),
    ).toBe(true);
    resolve(page());
    await screen.findByRole("button", { name: "Connect Google Workspace" });
    expect(api).toHaveBeenCalledWith("/api/connectors");
    expect(
      screen.getByText(
        /read and write access for the selected Google services/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Review the selected permissions in Google/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /require your approval here or with the buttons in your linked Telegram chat/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/read.only|Sending mail is not enabled/i),
    ).toBeNull();
  });

  it("opens the popup synchronously and authenticates the OAuth start request", async () => {
    const popup = popupFixture();
    let resolve!: (value: unknown) => void;
    const api = vi.fn(async (path: string) =>
      path === "/api/connectors"
        ? page()
        : new Promise((done) => (resolve = done)),
    );
    render(<ServiceConnections api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Google Workspace" }),
    );
    expect(window.open).toHaveBeenCalledWith(
      "about:blank",
      "durableclaw-google-oauth",
      "popup,width=600,height=750",
    );
    expect(api).toHaveBeenCalledWith("/api/connectors/google/connect", {
      method: "POST",
      body: JSON.stringify({ services: ["gmail"] }),
    });
    expect(popup.location.assign).not.toHaveBeenCalled();
    resolve({ authorization_url, expires_at: Date.now() + 600000 });
    await waitFor(() =>
      expect(popup.location.assign).toHaveBeenCalledWith(authorization_url),
    );
  });

  it.each([
    "https://evil.example/o/oauth2/v2/auth?state=x",
    "http://accounts.google.com/o/oauth2/v2/auth?state=x",
    "https://accounts.google.com/other?state=x",
    "https://user:pass@accounts.google.com/o/oauth2/v2/auth?state=x",
    "javascript:alert(1)",
    "https://accounts.google.com/o/oauth2/v2/auth",
  ])(
    "rejects an unexpected OAuth destination: %s",
    async (authorization_url) => {
      const popup = popupFixture();
      const api = vi.fn(async (path: string) =>
        path === "/api/connectors" ? page() : { authorization_url },
      );
      render(<ServiceConnections api={api} />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Connect Google Workspace" }),
      );
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Google Workspace could not be connected. Please try again.",
      );
      expect(popup.location.assign).not.toHaveBeenCalled();
      expect(popup.close).toHaveBeenCalledOnce();
    },
  );

  it("requires the exact popup, origin, state, and message type before exchanging a code", async () => {
    const popup = popupFixture();
    const api = oauthApi();
    render(<ServiceConnections api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Google Workspace" }),
    );
    await waitFor(() => expect(popup.location.assign).toHaveBeenCalledOnce());
    const data = {
      type: "durableclaw:oauth",
      state: "expected-state",
      code: "authorization-code",
    };
    relay(popup, data, "https://evil.example");
    relay(popup, { ...data, state: "other-state" });
    relay(popup, { ...data, type: "other-message" });
    relay(popup, { ...data, code: "x".repeat(8193) });
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data,
      }),
    );
    expect(
      api.mock.calls.some(
        ([path]) => path === "/api/connectors/google/callback",
      ),
    ).toBe(false);
    relay(popup, data);
    relay(popup, data);
    await screen.findByText("Google Workspace connected.");
    expect(api).toHaveBeenCalledWith("/api/connectors/google/callback", {
      method: "POST",
      body: JSON.stringify({
        state: "expected-state",
        code: "authorization-code",
      }),
    });
    expect(
      api.mock.calls.filter(
        ([path]) => path === "/api/connectors/google/callback",
      ),
    ).toHaveLength(1);
    expect(
      api.mock.calls.filter(([path]) => path === "/api/connectors"),
    ).toHaveLength(2);
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("explains popup blocking without initiating OAuth", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const api = oauthApi();
    render(<ServiceConnections api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Google Workspace" }),
    );
    await screen.findByText(
      "Allow popups for this site, then connect Google Workspace again.",
    );
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("disables connecting until the operator configures Google Workspace", async () => {
    render(<ServiceConnections api={vi.fn(async () => page([], false))} />);
    expect(
      (
        await screen.findByRole("button", { name: "Connect Google Workspace" })
      ).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(/workspace operator must configure Google Workspace/),
    ).toBeTruthy();
  });

  it("disconnects the selected account and refreshes the list", async () => {
    let listed = true;
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        listed = false;
        return { disconnected: true, revoked: true };
      }
      return page(listed ? [connected] : []);
    });
    render(<ServiceConnections api={api} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Disconnect owner@example.com",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(connected.account)).toBeNull(),
    );
    expect(api).toHaveBeenCalledWith("/api/connectors/connection%2F1", {
      method: "DELETE",
    });
    expect(
      api.mock.calls.filter(([path]) => path === "/api/connectors"),
    ).toHaveLength(2);
  });

  it("explains when local disconnection succeeded but Google revocation failed", async () => {
    const api = vi.fn(async (path: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? { disconnected: true, revoked: false }
        : page([connected]),
    );
    render(<ServiceConnections api={api} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Disconnect owner@example.com",
      }),
    );
    await screen.findByText(
      /Remove its access in your Google Account settings/,
    );
  });

  it("shows reauthorization status and prevents overlapping actions", async () => {
    const popup = popupFixture();
    const api = vi.fn(async (path: string) =>
      path === "/api/connectors"
        ? page([{ ...connected, status: "reauth_required" }])
        : { authorization_url },
    );
    render(<ServiceConnections api={api} />);
    await screen.findByText("Reconnect required");
    fireEvent.click(
      screen.getByRole("button", { name: "Reconnect Google Workspace" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Disconnect owner@example.com" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Refresh services" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await waitFor(() => expect(popup.location.assign).toHaveBeenCalledOnce());
  });

  it("reports loading failures without displaying API error contents and supports retry", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error("refresh_token=secret"))
      .mockResolvedValue(page());
    render(<ServiceConnections api={api} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "External services could not be loaded. Please try again.",
    );
    expect(screen.queryByText(/refresh_token/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh services" }));
    await screen.findByRole("button", { name: "Connect Google Workspace" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports callback failure without displaying provider details", async () => {
    const popup = popupFixture();
    const api = vi.fn(async (path: string) => {
      if (path === "/api/connectors") return page();
      if (path === "/api/connectors/google/connect")
        return { authorization_url };
      throw new Error("client_secret=secret");
    });
    render(<ServiceConnections api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Google Workspace" }),
    );
    await waitFor(() => expect(popup.location.assign).toHaveBeenCalledOnce());
    relay(popup, {
      type: "durableclaw:oauth",
      state: "expected-state",
      error: "access_denied",
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Google Workspace could not be connected. Please try again.",
    );
    expect(api).toHaveBeenCalledWith("/api/connectors/google/callback", {
      method: "POST",
      body: JSON.stringify({ state: "expected-state", error: "access_denied" }),
    });
    expect(screen.queryByText(/client_secret/)).toBeNull();
  });

  it.each(["closed", "expired"])(
    "cleans up a %s popup flow",
    async (reason) => {
      vi.useFakeTimers();
      const popup = popupFixture();
      const api = oauthApi();
      await act(async () => {
        render(<ServiceConnections api={api} />);
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Connect Google Workspace" }),
        );
      });
      if (reason === "closed") popup.closed = true;
      await act(async () => {
        vi.advanceTimersByTime(reason === "closed" ? 1000 : 600000);
      });
      expect(screen.getByRole("alert").textContent).toContain(
        reason === "closed" ? "cancelled" : "expired",
      );
      expect(
        screen
          .getByRole("button", { name: "Connect Google Workspace" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(popup.close).toHaveBeenCalledOnce();
      expect(
        api.mock.calls.some(
          ([path]) => path === "/api/connectors/google/callback",
        ),
      ).toBe(false);
    },
  );

  it("closes the popup and ignores callback messages after unmount", async () => {
    const popup = popupFixture();
    const api = oauthApi();
    const view = render(<ServiceConnections api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Google Workspace" }),
    );
    await waitFor(() => expect(popup.location.assign).toHaveBeenCalledOnce());
    view.unmount();
    relay(popup, {
      type: "durableclaw:oauth",
      state: "expected-state",
      code: "authorization-code",
    });
    expect(popup.close).toHaveBeenCalledOnce();
    expect(
      api.mock.calls.some(
        ([path]) => path === "/api/connectors/google/callback",
      ),
    ).toBe(false);
  });
});
