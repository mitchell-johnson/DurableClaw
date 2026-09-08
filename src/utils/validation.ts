export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const validMemoryId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(value);
export class RequestValidationError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}
export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestValidationError("JSON body must be an object");
  return value as Record<string, unknown>;
}
export async function boundedJson(
  request: Request,
  maxBytes = 65536,
): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new RequestValidationError("Request too large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestValidationError("Missing request body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes)
        throw new RequestValidationError("Request too large", 413);
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return jsonObject(JSON.parse(new TextDecoder().decode(body)));
}
