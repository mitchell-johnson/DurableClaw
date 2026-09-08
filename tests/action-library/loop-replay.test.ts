import { describe, it, expect, vi, afterEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { CHAT_MODEL } from "../../src/config";
import { runToolLoop } from "../../src/action-library/loop";
import { OpenRouterToolReplay } from "../../src/action-library/openrouterReplay";

vi.mock("../../src/telemetry/logger", () => ({ logError: vi.fn() }));

const env = {
  OPENROUTER_API_KEY: "test-key",
  CHAT_MODEL: "unit-test-model",
} as any;
const rawArguments = '{ "2": "second", "1": "first" }';
const reasoningDetails = [
  {
    type: "reasoning.text",
    text: "internal",
    signature: "signed-text",
    format: "google-gemini-v1",
    index: 0,
  },
  {
    type: "reasoning.encrypted",
    data: "opaque-signature",
    id: "call-one",
    format: "google-gemini-v1",
    index: 1,
  },
];
const extraContent = {
  google: { thought_signature: "opaque-native-signature" },
};

function response(
  deltas: Array<Record<string, unknown>>,
  finishReason = "stop",
) {
  const encoder = new TextEncoder();
  const lines = deltas.map((delta) => ({
    id: "completion-test",
    created: 0,
    model: CHAT_MODEL,
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
  lines.push({
    id: "completion-test",
    created: 0,
    model: CHAT_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  } as any);
  const text =
    lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") +
    "data: [DONE]\n\n";
  // Split inside JSON and UTF-8-independent text to exercise chunk buffering.
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, 47)));
        controller.enqueue(encoder.encode(text.slice(47)));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function firstStep() {
  return response(
    [
      { reasoning_details: [reasoningDetails[0]] },
      {
        tool_calls: [
          {
            index: 0,
            id: "call-one",
            type: "function",
            function: { name: "inspect", arguments: rawArguments.slice(0, 9) },
          },
        ],
      },
      {
        reasoning_details: [reasoningDetails[1]],
        tool_calls: [
          {
            index: 0,
            function: { arguments: rawArguments.slice(9) },
            extra_content: extraContent,
          },
        ],
      },
    ],
    "tool_calls",
  );
}

const params = {
  env,
  model: CHAT_MODEL,
  system: "Use tools",
  messages: [{ role: "user" as const, content: "Inspect records" }],
  tools: {
    inspect: tool({
      inputSchema: z.record(z.string(), z.string()),
      execute: async () => "result",
    }),
  },
  maxSteps: 3,
};

describe("OpenRouter signed tool replay", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips signed reasoning and exact arguments through a real two-step SDK loop", async () => {
    const requests: any[] = [];
    const events: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return requests.length === 1
        ? firstStep()
        : response([{ content: "Done" }]);
    });

    const result = await runToolLoop({
      ...params,
      onEvent: (e) => events.push(e),
    });

    expect(result.text).toBe("Done");
    expect(requests).toHaveLength(2);
    const assistant = requests[1].messages.find(
      (message: any) => message.tool_calls,
    );
    expect(assistant.reasoning_details).toEqual(reasoningDetails);
    expect(assistant.tool_calls[0].function.arguments).toBe(rawArguments);
    expect(assistant.tool_calls[0].extra_content).toEqual(extraContent);
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => e.content)
        .join(""),
    ).toBe("Done");
  });

  it("keeps parallel tool signatures and argument fragments associated with their indexes", async () => {
    const requests: any[] = [];
    const secondArguments = '{ "other": "value" }';
    const secondExtra = { google: { thought_signature: "second-signature" } };
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return requests.length === 1
        ? response(
            [
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-one",
                    type: "function",
                    function: {
                      name: "inspect",
                      arguments: rawArguments.slice(0, 9),
                    },
                  },
                  {
                    index: 1,
                    id: "call-two",
                    type: "function",
                    function: {
                      name: "inspect",
                      arguments: secondArguments.slice(0, 10),
                    },
                  },
                ],
              },
              {
                tool_calls: [
                  {
                    index: 1,
                    function: { arguments: secondArguments.slice(10) },
                    extra_content: secondExtra,
                  },
                ],
              },
              {
                reasoning_details: reasoningDetails,
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: rawArguments.slice(9) },
                    extra_content: extraContent,
                  },
                ],
              },
            ],
            "tool_calls",
          )
        : response([{ content: "Done" }]);
    });
    await runToolLoop(params);

    const assistant = requests[1].messages.find(
      (message: any) => message.tool_calls,
    );
    expect(assistant.reasoning_details).toEqual(reasoningDetails);
    expect(
      assistant.tool_calls.map((call: any) => [
        call.id,
        call.function.arguments,
        call.extra_content,
      ]),
    ).toEqual([
      ["call-one", rawArguments, extraContent],
      ["call-two", secondArguments, secondExtra],
    ]);
  });

  it("captures a late signature delta that omits the tool function and id", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return requests.length === 1
        ? response(
            [
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-one",
                    type: "function",
                    function: { name: "inspect", arguments: rawArguments },
                  },
                ],
              },
              {
                tool_calls: [{ index: 0, extra_content: extraContent }],
                reasoning_details: reasoningDetails,
              },
            ],
            "tool_calls",
          )
        : response([{ content: "Done" }]);
    });
    const result = await runToolLoop(params);

    expect(result.text).toBe("Done");
    const assistant = requests[1].messages.find(
      (message: any) => message.tool_calls,
    );
    expect(assistant.tool_calls[0].extra_content).toEqual(extraContent);
    expect(assistant.reasoning_details).toEqual(reasoningDetails);
  });

  it("does not share signed replay state between separate loops", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return requests.length === 1
        ? firstStep()
        : response([{ content: "Done" }]);
    });
    await runToolLoop(params);
    await runToolLoop({
      ...params,
      messages: [
        ...params.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-one",
              toolName: "inspect",
              input: { different: "input" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-one",
              toolName: "inspect",
              output: { type: "text", value: "ok" },
            },
          ],
        },
      ],
    });

    const assistant = requests[2].messages.find(
      (message: any) => message.tool_calls,
    );
    expect(assistant.reasoning_details).toBeUndefined();
    expect(assistant.tool_calls[0].extra_content).toBeUndefined();
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({
      different: "input",
    });
  });

  it("retains replay metadata when resuming the same user turn after persistence", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return requests.length === 1
        ? firstStep()
        : response([{ content: "Done" }]);
    });
    const first = await runToolLoop(params);
    await runToolLoop({
      ...params,
      messages: JSON.parse(
        JSON.stringify([...params.messages, ...first.responseMessages]),
      ),
    });

    const assistant = requests[2].messages.find(
      (message: any) => message.tool_calls,
    );
    expect(assistant.reasoning_details).toEqual(reasoningDetails);
    expect(assistant.tool_calls[0].function.arguments).toBe(rawArguments);
    expect(assistant.tool_calls[0].extra_content).toEqual(extraContent);
  });

  it.each([
    { content: "Continue" },
    { content: [{ type: "text" as const, text: "Continue" }] },
  ])(
    "continues a saved conversation with stale signatures, preserving current tool steps ($content)",
    async ({ content }) => {
      const requests: any[] = [];
      const execute = vi.fn(async () => "result");
      const currentReasoning = [
        {
          type: "reasoning.encrypted",
          data: "fresh-signature",
          id: "call-current",
          format: "google-gemini-v1",
          index: 0,
        },
      ];
      vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        requests.push(body);
        if (requests.length === 1) return firstStep();
        const oldAssistant = body.messages.find(
          (message: any) => message.tool_calls?.[0]?.id === "call-one",
        );
        if (
          oldAssistant.reasoning_details?.length ||
          oldAssistant.tool_calls[0].extra_content?.google?.thought_signature
        ) {
          return Response.json(
            {
              error: {
                message: "Provider returned error",
                code: 400,
                metadata: {
                  provider_name: "Google AI Studio",
                  raw: JSON.stringify({
                    error: {
                      code: 400,
                      message: "Corrupted thought signature.",
                      status: "INVALID_ARGUMENT",
                    },
                  }),
                },
              },
            },
            { status: 400 },
          );
        }
        return requests.length === 2
          ? response(
              [
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-current",
                      type: "function",
                      function: { name: "inspect", arguments: rawArguments },
                    },
                  ],
                  reasoning_details: currentReasoning,
                },
              ],
              "tool_calls",
            )
          : response([{ content: "Done" }]);
      });
      const tools = {
        inspect: tool({
          inputSchema: z.record(z.string(), z.string()),
          execute,
        }),
      };
      const first = await runToolLoop({ ...params, tools, maxSteps: 1 });
      const saved = JSON.parse(JSON.stringify(first.responseMessages));
      const messages = [
        ...params.messages,
        ...saved,
        { role: "user" as const, content },
      ];
      const before = JSON.stringify(messages);

      const result = await runToolLoop({ ...params, tools, messages });

      expect(result.text).toBe("Done");
      expect(requests).toHaveLength(3);
      // One original execution and one fresh execution; history is not rerun.
      expect(execute).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(messages)).toBe(before);
      for (const request of requests.slice(1)) {
        const oldAssistant = request.messages.find(
          (message: any) => message.tool_calls?.[0]?.id === "call-one",
        );
        expect(oldAssistant.reasoning_details).toBeUndefined();
        expect(
          oldAssistant.tool_calls[0].extra_content?.google?.thought_signature,
        ).toBeUndefined();
        expect(oldAssistant.tool_calls[0].function.arguments).toBe(
          rawArguments,
        );
        expect(
          request.messages.find(
            (message: any) => message.tool_call_id === "call-one",
          ).content,
        ).toBe("result");
      }
      const current = requests[2].messages.find(
        (message: any) => message.tool_calls?.[0]?.id === "call-current",
      );
      expect(current.reasoning_details).toEqual(currentReasoning);
      expect(current.tool_calls[0].function.arguments).toBe(rawArguments);
    },
  );

  it("removes only completed Gemini metadata, retaining other formats and native extension fields", () => {
    const otherReasoning = {
      type: "reasoning.encrypted",
      data: "other-provider-state",
      format: "anthropic-claude-v1",
      index: 0,
    };
    const replay = new OpenRouterToolReplay();
    const extensions = {
      google: { thought_signature: "stale", other: "keep" },
      custom: { value: "keep" },
    };
    replay.beginResponse()({
      index: 0,
      delta: {
        reasoning_details: [...reasoningDetails, otherReasoning],
        tool_calls: [
          {
            index: 0,
            id: "old",
            function: { name: "inspect", arguments: rawArguments },
            extra_content: extensions,
          },
        ],
      },
    });
    const init = {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Original task" },
          {
            role: "assistant",
            tool_calls: [
              { id: "old", function: { name: "inspect", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "old", content: "Saved result" },
          { role: "user", content: "New task" },
        ],
      }),
    };
    const before = JSON.stringify(init);
    const patched = replay.restoreRequest(init);
    const assistant = JSON.parse(patched!.body as string).messages[1];

    expect(assistant.reasoning_details).toEqual([otherReasoning]);
    expect(assistant.tool_calls[0].extra_content).toEqual({
      google: { other: "keep" },
      custom: { value: "keep" },
    });
    expect(assistant.tool_calls[0].function.arguments).toBe(rawArguments);
    expect(replay.restoreRequest(init)).toEqual(patched);
    expect(JSON.stringify(init)).toBe(before);
    expect(extensions.google.thought_signature).toBe("stale");
  });
});
