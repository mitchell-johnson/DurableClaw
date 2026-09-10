import { modelFor, OPENROUTER_BASE_URL } from "../config";
import {
  backgroundReasoningEffort,
  openRouterProvider,
  type OpenRouterRoutingEnv,
} from "./openrouterRouting";

export type BatchStatus =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "cancelling"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export interface BatchRequest {
  customId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface BatchResult {
  custom_id: string;
  response: unknown;
  error: unknown;
}

export interface OpenRouterBatch {
  id: string;
  status: BatchStatus;
  results: BatchResult[] | null;
}

export type BatchEnv = OpenRouterRoutingEnv & {
  OPENROUTER_API_KEY?: string;
  CHAT_MODEL?: string;
  BACKGROUND_MODEL?: string;
  BATCH_MODEL?: string;
};

const BATCH_URL = new URL("../beta/batches", `${OPENROUTER_BASE_URL}/`).href;
export const MAX_BATCH_REQUESTS = 20;
export const MAX_BATCH_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;
const STATUSES = new Set<BatchStatus>([
  "validating",
  "in_progress",
  "finalizing",
  "cancelling",
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

/** Errors deliberately contain neither prompts nor upstream response bodies. */
class BatchError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBatchId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

function authorization(env: BatchEnv): string {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new BatchError("OPENROUTER_API_KEY is required");
  return `Bearer ${key}`;
}

/** The outbox and HTTP sender must count the same JSON escaping and UTF-8 bytes. */
export function batchRequestByteLength(
  requests: readonly BatchRequest[],
  env: BatchEnv,
): number {
  return new TextEncoder().encode(serializeBatchRequest(requests, env))
    .byteLength;
}

function serializeBatchRequest(
  requests: readonly BatchRequest[],
  env: BatchEnv,
): string {
  // Order is part of the wire protocol: OpenRouter stream-parses endpoint and
  // model before requests. The async endpoint takes the base model slug;
  // the configured :batch variant identifies its pricing/routing capability.
  // Provider preferences are unsupported by this endpoint. createBatch
  // rejects pinned deployments before dispatch instead of weakening routing.
  return JSON.stringify({
    endpoint: "/v1/chat/completions",
    model: modelFor(env, "batch").replace(/:batch$/, ""),
    requests: requests.map((request) => ({
      custom_id: request.customId,
      body: {
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        ...(request.maxTokens !== undefined
          ? { max_tokens: request.maxTokens }
          : {}),
        reasoning: { effort: backgroundReasoningEffort(env) },
      },
    })),
  });
}

/**
 * Submit once. The API does not document idempotent creation; callers must
 * persist submission intent before this call and handle ambiguous failures.
 */
export async function createBatch(
  env: BatchEnv,
  requests: readonly BatchRequest[],
): Promise<OpenRouterBatch> {
  const auth = authorization(env);
  if (openRouterProvider(env))
    throw new BatchError(
      "OpenRouter Batch API cannot enforce OPENROUTER_PROVIDER; use durable synchronous housekeeping",
    );
  validateRequests(requests);

  const body = serializeBatchRequest(requests, env);
  if (new TextEncoder().encode(body).byteLength > MAX_BATCH_REQUEST_BYTES) {
    throw new BatchError("OpenRouter batch request exceeds size limit");
  }
  return fetchBatch(BATCH_URL, {
    method: "POST",
    body,
    headers: { Authorization: auth, "Content-Type": "application/json" },
  });
}

function validateRequests(requests: readonly BatchRequest[]): void {
  const ids = new Set<string>();
  if (
    requests.length === 0 ||
    requests.length > MAX_BATCH_REQUESTS ||
    requests.some((request) => {
      const invalid =
        typeof request.customId !== "string" ||
        !request.customId.trim() ||
        request.customId.length > 256 ||
        ids.has(request.customId) ||
        typeof request.system !== "string" ||
        typeof request.prompt !== "string" ||
        (request.maxTokens !== undefined &&
          (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1));
      ids.add(request.customId);
      return invalid;
    })
  ) {
    throw new BatchError("Invalid OpenRouter batch requests");
  }
}

/** One inference-only task; its caller persists intent and the returned text. */
export async function runPinnedHousekeeping(
  env: BatchEnv,
  request: BatchRequest,
): Promise<string | null> {
  const provider = openRouterProvider(env);
  if (!provider)
    throw new BatchError("Pinned housekeeping requires OPENROUTER_PROVIDER");
  validateRequests([request]);
  const serialized = JSON.parse(serializeBatchRequest([request], env));
  const body = JSON.stringify({
    model: serialized.model,
    ...serialized.requests[0].body,
    provider,
    stream: false,
  });
  if (new TextEncoder().encode(body).byteLength > MAX_BATCH_REQUEST_BYTES)
    throw new BatchError("OpenRouter housekeeping request exceeds size limit");
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: authorization(env),
        "Content-Type": "application/json",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BatchError(
        `OpenRouter housekeeping request failed (HTTP ${response.status})`,
      );
    }
    return batchResultText(
      {
        id: "synchronous",
        status: "completed",
        results: [
          {
            custom_id: request.customId,
            error: null,
            response: {
              status_code: response.status,
              body: await readBoundedJson(response),
            },
          },
        ],
      },
      request.customId,
    );
  } catch (error) {
    if (error instanceof BatchError) throw error;
    throw new BatchError("OpenRouter housekeeping transport failed");
  }
}

export async function getBatch(
  env: BatchEnv,
  id: string,
): Promise<OpenRouterBatch> {
  if (!validBatchId(id)) throw new BatchError("Invalid OpenRouter batch id");
  return fetchBatch(
    `${BATCH_URL}/${encodeURIComponent(id)}`,
    {
      method: "GET",
      headers: { Authorization: authorization(env) },
    },
    id,
  );
}

async function fetchBatch(
  url: string,
  init: RequestInit,
  expectedId?: string,
): Promise<OpenRouterBatch> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BatchError(
        `OpenRouter batch request failed (HTTP ${response.status})`,
      );
    }
    return parseBatch(await readBoundedJson(response), expectedId);
  } catch (error) {
    if (error instanceof BatchError) throw error;
    throw new BatchError("OpenRouter batch transport failed");
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new BatchError("Invalid OpenRouter batch response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BatchError("OpenRouter batch response exceeds size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BatchError("Invalid OpenRouter batch response");
  }
}

function parseBatch(value: unknown, expectedId?: string): OpenRouterBatch {
  if (
    !isRecord(value) ||
    !validBatchId(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status as BatchStatus)
  ) {
    throw new BatchError("Invalid OpenRouter batch response");
  }
  const status = value.status as BatchStatus;
  if (status !== "completed") return { id: value.id, status, results: null };
  if (
    value.error != null ||
    !Array.isArray(value.results) ||
    value.results.length > MAX_BATCH_REQUESTS
  ) {
    throw new BatchError("Invalid OpenRouter batch response");
  }
  const results: BatchResult[] = [];
  for (const result of value.results) {
    if (!isRecord(result) || typeof result.custom_id !== "string") {
      throw new BatchError("Invalid OpenRouter batch response");
    }
    results.push({
      custom_id: result.custom_id,
      response: result.response ?? null,
      error: result.error ?? null,
    });
  }
  return { id: value.id, status, results };
}

export function isBatchTerminal(status: BatchStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "expired" ||
    status === "cancelled"
  );
}

/** Accept only one unambiguous, complete text answer for the requested input. */
export function batchResultText(
  batch: OpenRouterBatch,
  customId: string,
): string | null {
  if (batch.status !== "completed" || !batch.results) return null;
  const matches = batch.results.filter(
    (result) => result.custom_id === customId,
  );
  if (matches.length !== 1) return null;
  const result = matches[0];
  if (
    result.error != null ||
    !isRecord(result.response) ||
    result.response.status_code !== 200
  )
    return null;
  const body = result.response.body;
  if (
    !isRecord(body) ||
    body.error != null ||
    !Array.isArray(body.choices) ||
    body.choices.length !== 1
  )
    return null;
  const choice = body.choices[0];
  if (
    !isRecord(choice) ||
    choice.finish_reason !== "stop" ||
    !isRecord(choice.message)
  )
    return null;
  const content = choice.message.content;
  return typeof content === "string" && content.trim() ? content : null;
}
