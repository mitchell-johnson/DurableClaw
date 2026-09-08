import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  principal: vi.fn(),
  retrieval: vi.fn(),
}));
vi.mock("../src/action-library/loop", async () => ({
  ...(await vi.importActual("../src/action-library/loop")),
  runToolLoop: mocks.run,
}));
vi.mock("../src/durable-objects/assistant/principal", () => ({
  buildRetrievalContextFor: mocks.principal,
}));
vi.mock("../src/durable-objects/assistant/subagentTools", () => ({
  buildSubagentToolset: mocks.retrieval,
}));
import {
  ResearchSubagent,
  type SubagentDispatch,
} from "../src/durable-objects/ResearchSubagent";
import { ToolLoopGenerationError } from "../src/action-library/loop";
import { createInternalAuthHeaders } from "../src/utils/internalAuth";

const SECRET = "unit-test-only-secret";
const owner = {
  userId: "user",
  organizationId: "workspace",
  tenantBinding: "workspace",
  role: "member",
};
const success = {
  text: "Two documents",
  finishReason: "stop",
  usage: { inputTokens: 20, outputTokens: 10 },
  toolCalls: [],
  responseMessages: [],
  chunkCount: 1,
};
const task = (): SubagentDispatch => ({
  task_id: "task",
  batch_id: "batch",
  goal: "Find relevant documents",
  tier: "background",
  toolset: ["search_records"],
  deadline_at: Date.now() + 60_000,
  coordinator_do_name: "workspace:user",
  context: {
    user_id: owner.userId,
    user_name: "User",
    user_role: owner.role,
    organization_id: owner.organizationId,
    tenant_binding: owner.tenantBinding,
  },
});
function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => structuredClone(values.get(key))),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
    deleteAll: vi.fn(async () => {
      values.clear();
    }),
    setAlarm: vi.fn(async (_time: number) => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const fetch = vi.fn(async (_request: Request) =>
    Response.json({ accepted: true }),
  );
  const get = vi.fn(() => ({ fetch }));
  const env = {
    NANO_CHAT_AGENT: { idFromName: vi.fn((name) => name), get },
    INTERNAL_AUTH_SECRET: SECRET,
  } as any;
  const state = { storage } as any;
  return {
    values,
    storage,
    fetch,
    get,
    env,
    state,
    agent: new ResearchSubagent(state, env),
  };
}
async function request(path: string, body: unknown) {
  return new Request(`https://service.test${path}`, {
    method: "POST",
    headers: await createInternalAuthHeaders(owner, SECRET),
    body: JSON.stringify(body),
  });
}
async function dispatch(f: ReturnType<typeof fixture>, value = task()) {
  return f.agent.fetch(await request("/dispatch", value));
}
const reported = (f: ReturnType<typeof fixture>, index = 0) =>
  f.fetch.mock.calls[index][0].clone().json() as Promise<any>;
beforeEach(() => {
  mocks.run.mockReset().mockResolvedValue(success);
  mocks.principal.mockReset().mockResolvedValue({ context: {} });
  mocks.retrieval
    .mockReset()
    .mockReturnValue({ search_records: { execute: async () => "documents" } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable child lifecycle", () => {
  it("persists and acknowledges dispatch without authority, retrieval, or provider work", async () => {
    const f = fixture();
    expect((await dispatch(f)).status).toBe(202);
    expect(f.values.get("task")).toMatchObject({ task_id: "task" });
    expect(f.storage.setAlarm).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.principal).not.toHaveBeenCalled();
    expect(mocks.retrieval).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
  it.each(["/dispatch", "/cancel"])(
    "rejects unsigned %s requests",
    async (path) => {
      const f = fixture();
      expect(
        (
          await f.agent.fetch(
            new Request(`https://service.test${path}`, {
              method: "POST",
              body: JSON.stringify(task()),
            }),
          )
        ).status,
      ).toBe(401);
      expect(f.values.size).toBe(0);
    },
  );
  it.each([
    { task_id: "" },
    { context: undefined },
    { tier: "unknown" },
    { deadline_at: null },
    { toolset: [] },
    { toolset: [42] },
    { task_id: 42 },
    { goal: {} },
    { goal: "x".repeat(32_001) },
  ])("validates load-bearing admission fields %j", async (patch) => {
    const f = fixture();
    expect((await dispatch(f, { ...task(), ...patch } as any)).status).toBe(
      400,
    );
    expect(f.values.size).toBe(0);
  });
  it("rejects a signed envelope for a different dispatch owner", async () => {
    const f = fixture();
    const value = task();
    value.context.user_id = "another-owner";
    expect((await dispatch(f, value)).status).toBe(403);
    expect(f.values.size).toBe(0);
  });
  it("makes duplicate dispatch idempotent and refuses another task on the same child", async () => {
    const f = fixture();
    await dispatch(f);
    expect(
      (await dispatch(f, { ...task(), goal: "Changed goal" })).status,
    ).toBe(202);
    expect(f.values.get("task")).toMatchObject({
      goal: "Find relevant documents",
    });
    expect((await dispatch(f, { ...task(), task_id: "another" })).status).toBe(
      409,
    );
  });
  it("recovers persisted work in a fresh instance and reports bounded success", async () => {
    const f = fixture();
    await dispatch(f);
    await new ResearchSubagent(f.state, f.env).alarm();
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(await reported(f)).toMatchObject({
      task_id: "task",
      status: "done",
      result: "Two documents",
      tokens_in: 20,
    });
    expect(f.values.size).toBe(0);
  });
  it("persists report before callback I/O and retries on a fresh stub without repeating generation", async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => {
      expect(f.values.get("report_pending")).toMatchObject({ attempts: 1 });
      expect(f.storage.setAlarm).toHaveBeenCalledTimes(2);
      throw new Error("Temporary network failure");
    });
    await dispatch(f);
    await f.agent.alarm();
    expect(f.values.get("report_pending")).toMatchObject({
      attempts: 1,
      payload: { status: "done" },
    });
    await new ResearchSubagent(f.state, f.env).alarm();
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(0);
  });
  it.each([404, 410])(
    "treats a retired parent response %s as terminal",
    async (status) => {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(new Response(null, { status }));
      await dispatch(f);
      await f.agent.alarm();
      expect(f.values.size).toBe(0);
      expect(mocks.run).toHaveBeenCalledOnce();
    },
  );
  it("bounds callback retries and expires abandoned reports", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error("Unavailable"));
    await dispatch(f);
    for (let attempt = 0; attempt < 8; attempt++)
      await new ResearchSubagent(f.state, f.env).alarm();
    expect(f.fetch).toHaveBeenCalledTimes(8);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(0);
  });
  it("does not repeat generation when cleanup fails after a successful report", async () => {
    const f = fixture();
    f.storage.delete.mockRejectedValueOnce(new Error("Storage unavailable"));
    await dispatch(f);
    await f.agent.alarm();
    expect(f.values.get("report_pending")).toMatchObject({ reported: true });
    await new ResearchSubagent(f.state, f.env).alarm();
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(0);
  });
  it("enforces the absolute deadline before slow authority hydration or model work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    mocks.principal.mockImplementationOnce(() => new Promise(() => {}));
    await dispatch(f, { ...task(), deadline_at: Date.now() + 50 });
    const alarm = f.agent.alarm();
    await vi.advanceTimersByTimeAsync(51);
    await alarm;
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await reported(f)).toMatchObject({ status: "failed" });
  });
  it("rejects expired work without starting authority hydration", async () => {
    const f = fixture();
    await dispatch(f, { ...task(), deadline_at: Date.now() - 1 });
    await f.agent.alarm();
    expect(mocks.principal).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await reported(f)).toMatchObject({ status: "failed" });
  });
  it("fails closed when authorization or the requested toolset no longer exists", async () => {
    const f = fixture();
    mocks.principal.mockResolvedValueOnce({ context: undefined });
    await dispatch(f);
    await f.agent.alarm();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await reported(f)).toMatchObject({ status: "failed" });
    const g = fixture();
    await dispatch(g, { ...task(), toolset: ["write_file"] });
    await g.agent.alarm();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await reported(g)).toMatchObject({ status: "failed" });
  });
  it("preserves incomplete generation and usage without misreporting provider filtering as empty success", async () => {
    const f = fixture();
    mocks.run.mockRejectedValueOnce(
      new ToolLoopGenerationError(new Error("provider body"), {
        ...success,
        text: "Incomplete finding",
        finishReason: "error",
      }),
    );
    await dispatch(f);
    await f.agent.alarm();
    expect(await reported(f)).toMatchObject({
      status: "failed",
      result: "Incomplete finding",
      tokens_in: 20,
      finish_reason: "error",
      error: "Model generation failed",
    });
    const g = fixture();
    mocks.run.mockResolvedValueOnce({
      ...success,
      finishReason: "content-filter",
      text: "Partial",
    });
    await dispatch(g);
    await g.agent.alarm();
    expect(await reported(g)).toMatchObject({
      status: "failed",
      result: "Partial",
      finish_reason: "content-filter",
    });
  });
  it("bounds durable result size and marks truncation", async () => {
    const f = fixture();
    mocks.run.mockResolvedValueOnce({ ...success, text: "x".repeat(40_000) });
    await dispatch(f);
    await f.agent.alarm();
    const payload = await reported(f);
    expect(payload.result).toHaveLength(32_000);
    expect(payload.finish_reason).toBe("length");
  });
  it("cancels before dispatch with an expiring tombstone", async () => {
    const f = fixture();
    await f.agent.fetch(await request("/cancel", { task_id: "task" }));
    expect(await (await dispatch(f)).json()).toMatchObject({
      accepted: false,
      cancelled: true,
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(f.storage.setAlarm.mock.calls[0][0]).toBeGreaterThan(Date.now());
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);
    await f.agent.alarm();
    expect(f.values.size).toBe(0);
  });
  it("aborts running work and ignores late provider success", async () => {
    const f = fixture();
    let finish: (result: typeof success) => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.run.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await dispatch(f);
    const alarm = f.agent.alarm();
    await running;
    await f.agent.fetch(await request("/cancel", { task_id: "task" }));
    finish(success);
    await alarm;
    expect(await reported(f)).toMatchObject({ status: "cancelled" });
    expect(f.values.has("cancelled")).toBe(true);
    expect(f.values.has("task")).toBe(false);
  });
  it("propagates deadline and cancellation to retrieval tools", async () => {
    const f = fixture();
    const execute = vi.fn(async () => "data");
    mocks.retrieval.mockReturnValueOnce({ search_records: { execute } });
    mocks.run.mockImplementationOnce(async (params) => {
      await params.tools.search_records.execute({}, {});
      return success;
    });
    await dispatch(f);
    await f.agent.alarm();
    expect(execute.mock.calls[0]).toEqual([
      {},
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    ]);
  });
});
