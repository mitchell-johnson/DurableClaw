export class ConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConnectorError(400, "Invalid request");
  return value as Record<string, unknown>;
}
export function fields(
  value: Record<string, unknown>,
  allowed: string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ConnectorError(400, "Invalid request");
}
export function textValue(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new ConnectorError(400, "Invalid request");
  return value;
}

export function validateGmailOperation(
  operation: unknown,
  input: unknown,
): { operation: string; arguments: Record<string, unknown> } {
  const args = record(input);
  if (operation === "gmail_search") {
    fields(args, ["query", "max", "include_body"]);
    const query = textValue(args.query, 2000);
    const max = args.max ?? 10;
    if (
      !Number.isInteger(max) ||
      Number(max) < 1 ||
      Number(max) > 50 ||
      (args.include_body !== undefined && args.include_body !== false)
    )
      throw new ConnectorError(400, "Invalid Gmail search arguments");
    return { operation, arguments: { query, max, include_body: false } };
  }
  if (operation === "gmail_get_message" || operation === "gmail_get_thread") {
    const idKey =
      operation === "gmail_get_message" ? "message_id" : "thread_id";
    fields(
      args,
      operation === "gmail_get_message"
        ? [idKey, "sanitize_content"]
        : [idKey, "sanitize_content", "full"],
    );
    const id = textValue(args[idKey], 128);
    if (
      !/^[a-f0-9]+$/i.test(id) ||
      (args.sanitize_content !== undefined && args.sanitize_content !== true) ||
      (args.full !== undefined && args.full !== false)
    )
      throw new ConnectorError(400, "Invalid Gmail read arguments");
    return {
      operation,
      arguments: {
        [idKey]: id,
        sanitize_content: true,
        ...(operation === "gmail_get_thread" ? { full: false } : {}),
      },
    };
  }
  throw new ConnectorError(400, "Unsupported connector operation");
}
