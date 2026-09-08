/** Log structural metadata only. Prompts, tool results, secrets and raw error bodies stay out of logs. */
const PRIVATE_FIELD =
  /(?:authorization|cookie|secret|token(?!s_(?:in|out))|password|email|phone|address|name|prompt|content|body|query|url|goal|result|args|input|output|error\.message)/i;

export function scrubPii(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[redacted]";
  if (typeof value === "string") {
    if (
      /\b[^\s@]+@[^\s@]+\.[^\s@]+\b|https?:\/\/|\b(?:sk-|Bearer\s)/i.test(value)
    )
      return "[redacted]";
    return value.slice(0, 256);
  }
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => scrubPii(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [
          key,
          PRIVATE_FIELD.test(key) ? "[redacted]" : scrubPii(item, depth + 1),
        ]),
    );
  return value;
}

function emit(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attributes?: Record<string, unknown>,
  error?: Error,
) {
  console[level](
    JSON.stringify({
      level,
      message: scrubPii(message),
      ...(attributes ? { attributes: scrubPii(attributes) } : {}),
      ...(error ? { error_type: error.name } : {}),
    }),
  );
}
export function logDebug(message: string, attributes?: Record<string, any>) {
  emit("debug", message, attributes);
}
export function logInfo(message: string, attributes?: Record<string, any>) {
  emit("info", message, attributes);
}
export function logWarn(message: string, attributes?: Record<string, any>) {
  emit("warn", message, attributes);
}
export function logError(
  message: string,
  error?: Error,
  attributes?: Record<string, any>,
) {
  emit("error", message, attributes, error);
}
