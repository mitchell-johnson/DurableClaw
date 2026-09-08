import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBatch,
  getBatch,
  batchRequestByteLength,
  batchResultText,
  MAX_BATCH_REQUEST_BYTES,
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
    expect(init.redirect).toBe("error");
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
