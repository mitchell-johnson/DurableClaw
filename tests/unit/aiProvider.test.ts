import { generateText, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/types";
import { createAISDKProvider } from "../../src/utils/aiProvider";

const env = {
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_PROVIDER: "google-ai-studio",
  BACKGROUND_REASONING_EFFORT: "high",
  CHAT_MODEL: "google/gemini-3.8-flash",
  BACKGROUND_MODEL: "google/gemini-3.8-flash",
} as Env;

function response(stream: boolean) {
  const base = { id: "generation-test", created: 1, model: env.CHAT_MODEL };
  if (!stream)
    return Response.json({
      ...base,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Ready" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  const chunks = [
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Ready" },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

describe("OpenRouter outgoing AI SDK transport", () => {
  it.each([
    ["foreground", false],
    ["foreground", true],
    ["background", false],
    ["background", true],
  ] as const)(
    "strictly pins %s inference with streaming=%s",
    async (purpose, streaming) => {
      const fetcher = vi.fn(async () => response(streaming));
      const provider = createAISDKProvider(env, { purpose, fetch: fetcher });
      const options = {
        model: provider.chat(purpose === "background" ? "background" : "chat"),
        prompt: "Test",
        maxRetries: 0,
      };
      const result = streaming
        ? streamText(options)
        : await generateText(options);
      expect(await result.text).toBe("Ready");
      const [url, init] = fetcher.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("google/gemini-3.8-flash");
      expect(body.provider).toEqual({
        only: ["google-ai-studio"],
        allow_fallbacks: false,
      });
      expect(body.reasoning).toEqual(
        purpose === "background" ? { effort: "high" } : undefined,
      );
    },
  );

  it("preserves unconfigured provider routing and default background effort", async () => {
    const fetcher = vi.fn(async () => response(false));
    const provider = createAISDKProvider(
      {
        ...env,
        OPENROUTER_PROVIDER: undefined,
        BACKGROUND_REASONING_EFFORT: undefined,
      },
      { purpose: "background", fetch: fetcher },
    );
    await generateText({
      model: provider.chat("background"),
      prompt: "Test",
      maxRetries: 0,
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      reasoning: { effort: "max" },
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("provider");
  });
});
