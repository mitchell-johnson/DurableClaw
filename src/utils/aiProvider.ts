import { createOpenAI } from "@ai-sdk/openai";
import type { Env } from "../types";
import { OPENROUTER_BASE_URL, modelFor, type RequestPurpose } from "../config";
import {
  backgroundReasoningEffort,
  openRouterProvider,
} from "./openrouterRouting";
export function createAISDKProvider(
  env: Env,
  options: { purpose?: RequestPurpose; fetch?: typeof fetch } = {},
) {
  if (!env.OPENROUTER_API_KEY) throw new Error("Configure OPENROUTER_API_KEY");
  const routing = openRouterProvider(env);
  const transport = options.fetch || fetch;
  const providerFetch: typeof fetch = async (input, init) => {
    if (
      (routing || options.purpose === "background") &&
      typeof init?.body === "string"
    ) {
      const body = JSON.parse(init.body);
      if (routing) body.provider = routing;
      if (
        options.purpose === "background" &&
        body.reasoning === undefined &&
        body.reasoning_effort === undefined
      )
        body.reasoning = { effort: backgroundReasoningEffort(env) };
      return transport(input, { ...init, body: JSON.stringify(body) });
    }
    if (routing)
      throw new Error("Cannot enforce OpenRouter provider on non-JSON request");
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
