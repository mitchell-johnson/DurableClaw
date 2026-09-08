import { createOpenAI } from "@ai-sdk/openai";
import type { Env } from "../types";
import { OPENROUTER_BASE_URL, modelFor, type RequestPurpose } from "../config";
export function createAISDKProvider(
  env: Env,
  options: { purpose?: RequestPurpose; fetch?: typeof fetch } = {},
) {
  if (!env.OPENROUTER_API_KEY) throw new Error("Configure OPENROUTER_API_KEY");
  const transport = options.fetch || fetch;
  const providerFetch: typeof fetch = async (input, init) => {
    if (options.purpose === "background" && typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      if (body.reasoning === undefined && body.reasoning_effort === undefined)
        body.reasoning = { effort: "max" };
      return transport(input, { ...init, body: JSON.stringify(body) });
    }
    return transport(input, init);
  };
  const provider = createOpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
    fetch: providerFetch,
  });
  return {
    chat: (id: string) =>
      provider.chat(
        ["chat", "background", "batch"].includes(id) ? modelFor(env, id) : id,
      ),
  };
}
