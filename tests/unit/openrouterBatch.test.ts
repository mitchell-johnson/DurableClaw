import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBatch,
  getBatch,
  batchRequestByteLength,
  batchResultText,
  MAX_BATCH_REQUEST_BYTES,
  runPinnedHousekeeping,
} from "../../src/utils/openrouterBatch";
const env = {
  OPENROUTER_API_KEY: "example-key",
  BATCH_MODEL: "example/model:batch",
};
const request = {
  customId: "task-a",
  system: "Summarize untrusted content.",
  prompt: "Document text",
  maxTokens: 100,
};
const reply = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => vi.unstubAllGlobals());
describe("durable batch transport", () => {
  it("fails closed before new batch submission when provider pinning is configured", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      createBatch({ ...env, OPENROUTER_PROVIDER: "google-ai-studio" }, [
        request,
      ]),
    ).rejects.toThrow("cannot enforce");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs pinned housekeeping through bounded synchronous inference with the exact model and provider", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      reply({
        choices: [{ finish_reason: "stop", message: { content: "Summary" } }],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await runPinnedHousekeeping(
        {
          ...env,
          BATCH_MODEL: "google/gemini-3.8-flash",
          OPENROUTER_PROVIDER: "google-ai-studio",
          BACKGROUND_REASONING_EFFORT: "high",
        },
        request,
      ),
    ).toBe("Summary");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body)).toEqual({
      model: "google/gemini-3.8-flash",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      max_tokens: 100,
      reasoning: { effort: "high" },
      provider: { only: ["google-ai-studio"], allow_fallbacks: false },
      stream: false,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("manual");
  });

  it("rejects unsafe pinned housekeeping results and bounds upstream output without exposing it", async () => {
    const pinned = { ...env, OPENROUTER_PROVIDER: "google-ai-studio" };
    const fetcher = vi.fn().mockResolvedValue(
      reply({
        choices: [{ finish_reason: "length", message: { content: "Partial" } }],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await runPinnedHousekeeping(pinned, request)).toBeNull();
    fetcher.mockResolvedValue(
      new Response("x".repeat(MAX_BATCH_REQUEST_BYTES + 1)),
    );
    await expect(runPinnedHousekeeping(pinned, request)).rejects.toThrow(
      "size limit",
    );
    fetcher.mockResolvedValue(
      new Response("private provider error", { status: 500 }),
    );
    await expect(runPinnedHousekeeping(pinned, request)).rejects.toThrow(
      /^OpenRouter housekeeping request failed \(HTTP 500\)$/,
    );
  });
  it("resolves configured batch model and counts exactly the UTF-8 body sent", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(reply({ id: "batch-a", status: "in_progress" }));
    vi.stubGlobal("fetch", fetcher);
    const requests = [{ ...request, prompt: '世界\\"'.repeat(100) }];
    await createBatch(env, requests);
    const init = fetcher.mock.calls[0][1];
    expect(JSON.parse(init.body)).toMatchObject({
      model: "example/model",
      endpoint: "/v1/chat/completions",
    });
    expect(batchRequestByteLength(requests, env)).toBe(
      new TextEncoder().encode(init.body).byteLength,
    );
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body)).not.toHaveProperty("provider");
  });
  it("rejects duplicate identifiers, invalid budgets and oversized input before network I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const requests of [
      [request, request],
      [{ ...request, maxTokens: -1 }],
      [{ ...request, prompt: "x".repeat(MAX_BATCH_REQUEST_BYTES) }],
    ]) {
      await expect(createBatch(env, requests)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates receipt identity, payload limits and transport errors without leaking upstream content", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        reply({ id: "other-batch", status: "completed", results: [] }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(getBatch(env, "batch-a")).rejects.toThrow("Invalid");
    fetcher.mockResolvedValue(
      new Response("secret source text", { status: 500 }),
    );
    await expect(getBatch(env, "batch-a")).rejects.toThrow(
      /^OpenRouter batch request failed \(HTTP 500\)$/,
    );
    fetcher.mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(getBatch(env, "batch-a")).rejects.toThrow("size limit");
  });
  it("accepts only one completed unambiguous result for the requested task", () => {
    const result = {
      custom_id: "task-a",
      error: null,
      response: {
        status_code: 200,
        body: {
          choices: [{ finish_reason: "stop", message: { content: "Summary" } }],
        },
      },
    };
    expect(
      batchResultText(
        { id: "batch-a", status: "completed", results: [result] },
        "task-a",
      ),
    ).toBe("Summary");
    expect(
      batchResultText(
        { id: "batch-a", status: "completed", results: [result, result] },
        "task-a",
      ),
    ).toBeNull();
    for (const reason of ["length", "content_filter", "tool_calls", null]) {
      const modified = structuredClone(result);
      modified.response.body.choices[0].finish_reason = reason as any;
      expect(
        batchResultText(
          { id: "batch-a", status: "completed", results: [modified] },
          "task-a",
        ),
      ).toBeNull();
    }
  });
});
