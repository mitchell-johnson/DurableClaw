import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeRunner,
  validateScript,
  WALL_LIMIT_MS,
} from "../src/services/code/CodeRunner";
import { createCodeTools } from "../src/action-library/tools/code";
import { applyPersonaToolGate } from "../src/durable-objects/assistant/tools";

afterEach(() => vi.useRealTimers());
function fixture() {
  const fetch = vi.fn(async () => Response.json({ result: 42 }));
  const load = vi.fn(() => ({ getEntrypoint: () => ({ fetch }) }));
  return {
    fetch,
    load,
    runner: new CodeRunner({ load } as unknown as WorkerLoader),
  };
}
describe("code tool boundaries", () => {
  it("uses fixed isolation settings and validates input before loading", async () => {
    const f = fixture();
    await expect(f.runner.run(" ")).rejects.toThrow("code must");
    await expect(f.runner.run("code", "not json")).rejects.toThrow();
    expect(f.load).not.toHaveBeenCalled();
    await f.runner.run("export default () => 42", "{}");
    expect(f.load.mock.calls[0][0]).toMatchObject({
      globalOutbound: null,
      env: {},
      compatibilityFlags: [],
      limits: { cpuMs: 1000, subRequests: 0 },
    });
    expect(() => validateScript("x".repeat(32001), "null")).toThrow();
  });
  it("bounds the actual response independently of the script wrapper", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response('"' + "x".repeat(49000) + '"'));
    await expect(f.runner.run("code")).rejects.toThrow("48000 bytes");
    expect((await f.runner.run("code")).output).toEqual({ result: 42 });
  });
  it("rejects concurrent runs and stops waiting at its deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetch.mockImplementationOnce(() => new Promise(() => {}));
    const run = f.runner.run("code");
    const rejected = expect(run).rejects.toThrow("deadline");
    await expect(f.runner.run("code")).rejects.toThrow("already running");
    await vi.advanceTimersByTimeAsync(WALL_LIMIT_MS);
    await rejected;
    expect((await f.runner.run("code")).output).toEqual({ result: 42 });
  });
  it("propagates cancellation and cancels stalled output streams", async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const controller = new AbortController();
    const run = f.runner.run("code", "null", controller.signal);
    const rejected = expect(run).rejects.toThrow("stop");
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error("stop"));
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
  it("handles compilation failure without retaining the busy flag", async () => {
    const f = fixture();
    f.load.mockImplementationOnce(() => {
      throw new Error("syntax");
    });
    await expect(f.runner.run("bad code")).rejects.toThrow("syntax");
    await expect(f.runner.run("code")).resolves.toMatchObject({
      output: { result: 42 },
    });
  });
  it("is optional, persona controlled, authorized and limited per turn", async () => {
    expect(createCodeTools({ authorize: async () => {} })).toEqual({});
    const f = fixture();
    const authorize = vi.fn(async () => {});
    const tools = createCodeTools({
      runner: f.runner,
      conversationId: "one",
      authorize,
    });
    expect(
      applyPersonaToolGate(tools, { disabled_tools: ["execute_code"] }),
    ).toEqual({});
    const execute = () =>
      tools.execute_code.execute!(
        { code: "code" },
        { toolCallId: "test", messages: [] },
      );
    authorize.mockRejectedValueOnce(new Error("denied"));
    expect(await execute()).toContain("denied");
    expect(f.load).not.toHaveBeenCalled();
    for (let i = 0; i < 8; i++) await execute();
    expect(await execute()).toContain("limit reached");
    expect(f.load).toHaveBeenCalledTimes(8);
  });
});
