export interface OpenRouterRoutingEnv {
  /** One exact OpenRouter provider slug; omitted preserves account routing. */
  OPENROUTER_PROVIDER?: string;
  BACKGROUND_REASONING_EFFORT?: string;
}

export function openRouterProvider(env: OpenRouterRoutingEnv) {
  const provider = env.OPENROUTER_PROVIDER?.trim();
  if (!provider) return undefined;
  if (!/^[a-z0-9][a-z0-9_/-]{0,127}$/.test(provider))
    throw new Error("Invalid OPENROUTER_PROVIDER slug");
  return { only: [provider], allow_fallbacks: false as const };
}

export function backgroundReasoningEffort(env: OpenRouterRoutingEnv): string {
  const effort = env.BACKGROUND_REASONING_EFFORT?.trim() || "max";
  if (
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      effort,
    )
  )
    throw new Error("Invalid BACKGROUND_REASONING_EFFORT");
  return effort;
}
