// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("../../src/hooks/useAgentChat", () => ({
  useAgentChat: () => ({
    connect: async () => {},
    conversations: [],
    messages: [],
    toolResults: [],
    activeToolCalls: [],
    isConnected: true,
    isLoading: false,
    isStreaming: false,
    isResearching: false,
    conversationId: null,
    error: null,
    staleConversation: null,
  }),
}));

import { App } from "../../src/app";

const lastChecked = Date.UTC(2026, 8, 10, 8);
const nextCheck = lastChecked + 60 * 60_000;
const persona = {
  persona: "Help me prioritize my work.",
  identity_override: "Be brief.",
  reasoning_effort: "fast",
  memory_enabled: true,
  wake_interval_minutes: 60 as number | null,
  dream_interval_hours: 24,
  disabled_tools: ["write_file"],
  mcp_servers: [{ name: "notes", url: "https://notes.example.com/mcp" }],
};
const heartbeat = {
  enabled: true,
  intervalMinutes: 60 as number | null,
  nextRunAt: nextCheck as number | null,
  lastRun: {
    status: "quiet",
    startedAt: lastChecked - 10_000,
    completedAt: lastChecked,
    error: null as string | null,
  },
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function apiStub(
  handlePersona: (init: RequestInit) => Response | Promise<Response>,
) {
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    if (path === "/api/auth/options")
      return Response.json({ enabled: false, accessRecovery: false });
    if (path === "/api/session")
      return Response.json({ authenticated: true, auth_mode: "access" });
    if (path === "/api/agent/persona") return handlePersona(init);
    return Response.json({ success: true });
  });
  vi.stubGlobal("fetch", request);
  return request;
}

async function openSettings() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  return (await screen.findByLabelText("Heartbeat")) as HTMLSelectElement;
}

describe("heartbeat settings", () => {
  it("shows the hourly schedule and the last and next checks from the server", async () => {
    apiStub(() => Response.json({ persona, heartbeat }));
    const interval = await openSettings();
    expect(interval.value).toBe("60");
    expect(interval.selectedOptions[0].text).toBe("Every 1 hour");
    expect(
      screen.getByText(/workspace events and connected Gmail/),
    ).toBeTruthy();
    expect(
      screen.getByText(/stays quiet when nothing needs your attention/),
    ).toBeTruthy();
    expect(screen.getByText(/Inbox and linked messaging apps/)).toBeTruthy();
    expect(screen.getByText("Nothing needed your attention.")).toBeTruthy();
    expect(
      screen.getByText(/Last check:/).querySelector("time")?.dateTime,
    ).toBe(new Date(lastChecked).toISOString());
    expect(
      screen.getByText(/Next check:/).querySelector("time")?.dateTime,
    ).toBe(new Date(nextCheck).toISOString());
  });

  it("saves a changed interval without losing other settings and refreshes the next check", async () => {
    const updatedNext = nextCheck + 60 * 60_000;
    const request = apiStub((init) =>
      Response.json(
        init.method === "PUT"
          ? {
              persona: { ...persona, wake_interval_minutes: 120 },
              heartbeat: {
                ...heartbeat,
                intervalMinutes: 120,
                nextRunAt: updatedNext,
              },
            }
          : { persona, heartbeat },
      ),
    );
    const interval = await openSettings();
    fireEvent.change(interval, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Saved");
    const save = request.mock.calls.find(
      ([path, init]) => path === "/api/agent/persona" && init.method === "PUT",
    );
    expect(JSON.parse(save![1].body as string)).toEqual({
      ...persona,
      wake_interval_minutes: 120,
    });
    expect(interval.selectedOptions[0].text).toBe("Every 2 hours");
    expect(
      screen.getByText(/Next check:/).querySelector("time")?.dateTime,
    ).toBe(new Date(updatedNext).toISOString());
    expect(
      request.mock.calls.filter(([path]) => path === "/api/agent/persona"),
    ).toHaveLength(2);
  });

  it("turns the heartbeat off and removes the scheduled next check", async () => {
    const request = apiStub((init) =>
      Response.json(
        init.method === "PUT"
          ? {
              persona: { ...persona, wake_interval_minutes: null },
              heartbeat: {
                ...heartbeat,
                enabled: false,
                intervalMinutes: null,
                nextRunAt: null,
              },
            }
          : { persona, heartbeat },
      ),
    );
    const interval = await openSettings();
    fireEvent.change(interval, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Saved");
    const save = request.mock.calls.find(([, init]) => init.method === "PUT");
    expect(
      JSON.parse(save![1].body as string).wake_interval_minutes,
    ).toBeNull();
    expect(interval.selectedOptions[0].text).toBe("Off");
    expect(screen.queryByText(/Next check:/)).toBeNull();
  });

  it("preserves an existing Off preference instead of enabling an hourly schedule", async () => {
    apiStub(() =>
      Response.json({
        persona: { ...persona, wake_interval_minutes: null },
        heartbeat: {
          enabled: false,
          intervalMinutes: null,
          nextRunAt: null,
          lastRun: null,
        },
      }),
    );
    const interval = await openSettings();
    expect(interval.selectedOptions[0].text).toBe("Off");
    expect(screen.queryByText(/Last check:/)).toBeNull();
    expect(screen.queryByText(/Next check:/)).toBeNull();
  });

  it("refreshes status when an older save response omits heartbeat metadata", async () => {
    let saved = false;
    apiStub((init) => {
      if (init.method === "PUT") {
        saved = true;
        return Response.json({ success: true });
      }
      return Response.json({
        persona,
        heartbeat: saved
          ? { ...heartbeat, nextRunAt: nextCheck + 60 * 60_000 }
          : heartbeat,
      });
    });
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Saved");
    expect(
      screen.getByText(/Next check:/).querySelector("time")?.dateTime,
    ).toBe(new Date(nextCheck + 60 * 60_000).toISOString());
  });

  it("shows a retryable save error without claiming a new schedule was saved", async () => {
    apiStub((init) =>
      init.method === "PUT"
        ? new Response(null, { status: 503 })
        : Response.json({ persona, heartbeat }),
    );
    const interval = await openSettings();
    fireEvent.change(interval, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Please try again",
    );
    expect(screen.queryByText("Saved")).toBeNull();
    expect(interval.value).toBe("120");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save settings" }),
      ).toHaveProperty("disabled", false),
    );
    expect(
      screen.getByText(/Next check:/).querySelector("time")?.dateTime,
    ).toBe(new Date(nextCheck).toISOString());
  });

  it("explains a failed check without exposing internal error details", async () => {
    apiStub(() =>
      Response.json({
        persona,
        heartbeat: {
          ...heartbeat,
          lastRun: {
            ...heartbeat.lastRun,
            status: "failed",
            error: "Internal credential details",
          },
        },
      }),
    );
    await openSettings();
    expect(screen.getByText(/The last check could not finish/)).toBeTruthy();
    expect(screen.queryByText(/Internal credential details/)).toBeNull();
    expect(screen.getByText(/Next check:/)).toBeTruthy();
  });

  it.each(["quiet", "completed"])(
    "shows incomplete source checks instead of a %s outcome",
    async (status) => {
      apiStub(() =>
        Response.json({
          persona,
          heartbeat: {
            ...heartbeat,
            lastRun: {
              ...heartbeat.lastRun,
              status,
              error: "Private provider diagnostics",
            },
          },
        }),
      );
      await openSettings();
      expect(
        screen.getByText(
          "Some sources could not be checked. They will be retried.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("Nothing needed your attention.")).toBeNull();
      expect(screen.queryByText("Check complete.")).toBeNull();
      expect(screen.queryByText(/Private provider diagnostics/)).toBeNull();
      expect(screen.getByText(/Next check:/)).toBeTruthy();
    },
  );
});
