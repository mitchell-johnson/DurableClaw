import { fitVectorMetadata } from "./vectorMetadata";
/** Namespace-isolated semantic memory on Workers AI, Vectorize and R2.
 * The Durable Object owns recall tiers, provenance and retry intent; R2 keeps
 * an exactly enumerable remote inventory under memory/ for management/purge.
 */
import { createHash } from "node:crypto";
import { logWarn } from "../telemetry/logger";

export type AgentMemoryType =
  "raw" | "summary" | "memory" | "tool_call" | "insight";
export const MEMORY_TYPE_WEIGHTS: Readonly<Record<AgentMemoryType, number>> = {
  memory: 1.5,
  insight: 1.3,
  summary: 1.2,
  tool_call: 1.1,
  raw: 1.0,
};
export interface AgentMemoryRecord {
  vector_id: string;
  type: AgentMemoryType;
  content_preview: string;
  user_id: string;
  tenant_binding: string;
  tenant_id: string;
  conversation_id?: string;
  created_at: number;
  extra?: Record<string, string | number | boolean>;
}
export interface AgentMemoryMatch {
  vector_id: string;
  score: number;
  weighted_score: number;
  metadata: AgentMemoryRecord & { user_namespace: string };
}
interface MemoryEnv {
  AI?: Ai;
  MEMORY_INDEX?: VectorizeIndex;
  WORKSPACE?: R2Bucket;
}
const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const MEMORY_DIMENSIONS = 1024;
export const MAX_LIST_LIMIT = 50;
export const MAX_LIST_OFFSET = Number.MAX_SAFE_INTEGER;

/** Collision-resistant tuple encoding, bounded to Vectorize's 64-byte limit. */
export function buildNamespace(
  user_id: string,
  tenant_binding: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([tenant_binding, user_id]))
    .digest("hex");
}
export function buildVectorId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
const bounded = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) =>
  Math.min(
    max,
    Math.max(min, Number.isFinite(value) ? Math.floor(value!) : fallback),
  );

async function embedding(env: MemoryEnv, text: string): Promise<number[]> {
  if (!env.AI) throw new Error("AI binding is required for semantic memory");
  const result = (await env.AI.run(EMBEDDING_MODEL, {
    text: [text.slice(0, 60_000)],
  })) as { data?: number[][] };
  const values = result?.data?.[0];
  // Changing dimensions on fallback would corrupt the index; fail explicitly.
  if (
    !Array.isArray(values) ||
    values.length !== MEMORY_DIMENSIONS ||
    !values.every(Number.isFinite)
  ) {
    throw new Error("Memory embedding has invalid dimensions or values");
  }
  return values;
}
function unavailable(): void {
  logWarn("Memory index unavailable", { "memory.binding": "MEMORY_INDEX" });
}
function toMatch(value: {
  id: string;
  score?: number;
  metadata?: unknown;
}): AgentMemoryMatch {
  const meta = (value.metadata ?? {}) as Partial<AgentMemoryRecord> & {
    user_namespace?: string;
    extra_json?: string;
  };
  let extra = meta.extra;
  if (!extra && typeof meta.extra_json === "string") {
    try {
      extra = JSON.parse(meta.extra_json);
    } catch {
      /* malformed optional metadata is ignored */
    }
  }
  const type =
    meta.type && Object.hasOwn(MEMORY_TYPE_WEIGHTS, meta.type)
      ? meta.type
      : "raw";
  const score = value.score ?? 1;
  return {
    vector_id: value.id,
    score,
    weighted_score: score * MEMORY_TYPE_WEIGHTS[type],
    metadata: {
      vector_id: value.id,
      type,
      content_preview: meta.content_preview ?? "",
      user_id: meta.user_id ?? "",
      tenant_binding: meta.tenant_binding ?? "",
      tenant_id: meta.tenant_id ?? meta.tenant_binding ?? "",
      conversation_id: meta.conversation_id,
      created_at: meta.created_at ?? 0,
      extra,
      user_namespace: meta.user_namespace ?? "",
    },
  };
}
export async function writeMemory(
  env: MemoryEnv,
  args: {
    user_id: string;
    tenant_binding: string;
    type: AgentMemoryType;
    content: string;
    content_preview?: string;
    conversation_id?: string;
    vector_id?: string;
    extra?: Record<string, string | number | boolean>;
    stillValid?: () => boolean;
    /** Durable owners journal and schedule compensation before issuing it. */
    deferCompensationToOwner?: boolean;
  },
): Promise<{ vector_id: string; persisted: boolean }> {
  const vector_id = args.vector_id ?? buildVectorId();
  if (!env.MEMORY_INDEX) {
    unavailable();
    return { vector_id, persisted: false };
  }
  const namespace = buildNamespace(args.user_id, args.tenant_binding);
  const bucket = requireInventory(env);
  const values = await embedding(env, args.content);
  if (args.stillValid && !args.stillValid())
    return { vector_id, persisted: false };
  const metadata: AgentMemoryRecord & { user_namespace: string } = {
    vector_id,
    type: args.type,
    content_preview: (args.content_preview ?? args.content.slice(0, 200))
      .slice(0, 4000)
      .replaceAll("\n", " "),
    user_id: args.user_id,
    tenant_binding: args.tenant_binding,
    tenant_id: args.tenant_binding,
    user_namespace: namespace,
    created_at: Date.now(),
    ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}),
    ...(args.extra ? { extra: args.extra } : {}),
  };
  // Write both inventory keys before the vector, so ambiguous upserts can be
  // enumerated and purged. The global ID record is a deletion locator only.
  await bucket.put(recordKey(vector_id), JSON.stringify(metadata));
  await bucket.put(
    namespaceKey(namespace, vector_id),
    JSON.stringify(metadata),
  );
  if (args.stillValid && !args.stillValid()) {
    if (!args.deferCompensationToOwner)
      await deleteMemoriesByIds(env, [vector_id]);
    return { vector_id, persisted: false };
  }
  const { extra, ...vectorMetadata } = metadata;
  await env.MEMORY_INDEX.upsert([
    {
      id: vector_id,
      values,
      namespace,
      metadata: fitVectorMetadata({
        ...vectorMetadata,
        ...(extra ? { extra_json: JSON.stringify(extra) } : {}),
      }),
    },
  ]);
  return { vector_id, persisted: true };
}
function memoryFilter(
  namespace: string,
  types?: AgentMemoryType[],
  conversationId?: string,
) {
  return {
    user_namespace: { $eq: namespace },
    ...(types?.length
      ? { type: types.length === 1 ? { $eq: types[0] } : { $in: types } }
      : {}),
    ...(conversationId ? { conversation_id: { $eq: conversationId } } : {}),
  };
}
export async function queryMemory(
  env: MemoryEnv,
  args: {
    user_id: string;
    tenant_binding: string;
    query_text: string;
    topK?: number;
    typeFilter?: AgentMemoryType[];
  },
): Promise<AgentMemoryMatch[]> {
  if (!env.MEMORY_INDEX) {
    unavailable();
    return [];
  }
  const namespace = buildNamespace(args.user_id, args.tenant_binding);
  const result = await env.MEMORY_INDEX.query(
    await embedding(env, args.query_text),
    {
      namespace,
      filter: memoryFilter(namespace, args.typeFilter),
      topK: bounded(args.topK, 12, 1, 50),
      returnMetadata: "all",
    },
  );
  // Native namespace plus metadata filter plus post-check: fail closed even
  // against stale or malformed index responses from a test/custom adapter.
  return activeInventoryMatches(
    env,
    result.matches
      .map(toMatch)
      .filter(
        (m) =>
          m.metadata.user_namespace === namespace &&
          (!args.typeFilter?.length ||
            args.typeFilter.includes(m.metadata.type)),
      ),
  );
}
/** IDs must come from the owning local inventory; consumers also verify scope. */
export async function getMemoriesByIds(
  env: Pick<MemoryEnv, "MEMORY_INDEX" | "WORKSPACE">,
  ids: string[],
): Promise<AgentMemoryMatch[]> {
  if (!env.MEMORY_INDEX) {
    unavailable();
    return [];
  }
  if (!ids.length) return [];
  const out: AgentMemoryMatch[] = [];
  for (let i = 0; i < ids.length; i += 100)
    out.push(
      ...(await env.MEMORY_INDEX.getByIds(ids.slice(i, i + 100))).map(toMatch),
    );
  return activeInventoryMatches(env, out);
}
/** R2 is the live inventory; a Vectorize mutation receipt does not establish
 * index convergence. Rehydrate from inventory so stale hits cannot expose purged
 * content. Owners still apply their SQL visibility check after this await. */
async function activeInventoryMatches(
  env: Pick<MemoryEnv, "WORKSPACE">,
  matches: AgentMemoryMatch[],
): Promise<AgentMemoryMatch[]> {
  const bucket = requireInventory(env);
  const active: AgentMemoryMatch[] = [];
  for (let i = 0; i < matches.length; i += 20) {
    const rows = await Promise.all(
      matches.slice(i, i + 20).map(async (match) => {
        if (!/^[a-f0-9]{64}$/.test(match.metadata.user_namespace)) return null;
        const object = await bucket.get(
          namespaceKey(match.metadata.user_namespace, match.vector_id),
        );
        if (!object) return null;
        const record = await object.json<
          AgentMemoryRecord & { user_namespace: string }
        >();
        if (
          record.vector_id !== match.vector_id ||
          record.user_namespace !== match.metadata.user_namespace
        )
          return null;
        return toMatch({
          id: match.vector_id,
          score: match.score,
          metadata: record,
        });
      }),
    );
    for (const row of rows) if (row) active.push(row);
  }
  return active;
}
function requireInventory(env: Pick<MemoryEnv, "WORKSPACE">): R2Bucket {
  if (!env.WORKSPACE)
    throw new Error(
      "WORKSPACE binding is required for durable memory inventory",
    );
  return env.WORKSPACE;
}
const recordKey = (id: string) =>
  `memory/records/${encodeURIComponent(id)}.json`;
const namespacePrefix = (namespace: string) =>
  `memory/namespaces/${namespace}/`;
const namespaceKey = (namespace: string, id: string) =>
  `${namespacePrefix(namespace)}${encodeURIComponent(id)}.json`;

export async function deleteMemoriesByIds(
  env: Pick<MemoryEnv, "MEMORY_INDEX" | "WORKSPACE">,
  ids: string[],
  namespaceById: Record<string, string> = {},
): Promise<void> {
  if (!env.MEMORY_INDEX) {
    unavailable();
    return;
  }
  if (!ids.length) return;
  const bucket = requireInventory(env);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const records = await Promise.all(
      chunk.map(async (id) => {
        const object = await bucket.get(recordKey(id));
        const record = object
          ? await object.json<AgentMemoryRecord & { user_namespace: string }>()
          : null;
        return { id, record };
      }),
    );
    await env.MEMORY_INDEX.deleteByIds(chunk);
    // Delete namespace entries before locators. A failed deletion leaves its
    // locator intact so the owning SQL outbox can retry after eviction.
    const namespaceKeys = records.flatMap((row) => {
      const namespaces = new Set([
        row.record?.user_namespace,
        namespaceById[row.id],
      ]);
      return [...namespaces]
        .filter(
          (namespace): namespace is string =>
            typeof namespace === "string" && /^[a-f0-9]{64}$/.test(namespace),
        )
        .map((namespace) => namespaceKey(namespace, row.id));
    });
    if (namespaceKeys.length) await bucket.delete(namespaceKeys);
    await bucket.delete(chunk.map(recordKey));
  }
}
async function inventoryRecords(
  env: Pick<MemoryEnv, "WORKSPACE">,
  namespace: string,
): Promise<AgentMemoryMatch[]> {
  const bucket = requireInventory(env);
  const records: AgentMemoryMatch[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: namespacePrefix(namespace),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (let i = 0; i < page.objects.length; i += 20) {
      const chunk = await Promise.all(
        page.objects.slice(i, i + 20).map(async (row) => {
          const object = await bucket.get(row.key);
          return object
            ? object.json<AgentMemoryRecord & { user_namespace: string }>()
            : null;
        }),
      );
      for (const row of chunk) {
        if (
          !row ||
          row.user_namespace !== namespace ||
          typeof row.vector_id !== "string"
        )
          continue;
        records.push(toMatch({ id: row.vector_id, metadata: row }));
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor)
      throw new Error("Incomplete memory inventory page");
  } while (cursor);
  return records;
}
/** Exact chronological management pages over the remote inventory. */
export async function listMemories(
  env: MemoryEnv,
  args: {
    user_id: string;
    tenant_binding: string;
    typeFilter?: AgentMemoryType[];
    conversation_id?: string;
    offset?: number;
    limit?: number;
  },
): Promise<{ matches: AgentMemoryMatch[]; total_returned: number }> {
  const all = (
    await inventoryRecords(
      env,
      buildNamespace(args.user_id, args.tenant_binding),
    )
  ).filter(
    (m) =>
      (!args.typeFilter?.length || args.typeFilter.includes(m.metadata.type)) &&
      (!args.conversation_id ||
        m.metadata.conversation_id === args.conversation_id),
  );
  all.sort(
    (a, b) =>
      b.metadata.created_at - a.metadata.created_at ||
      a.vector_id.localeCompare(b.vector_id),
  );
  const limit = bounded(args.limit, 30, 1, MAX_LIST_LIMIT);
  const offset = bounded(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    matches: all.slice(offset, offset + limit),
    total_returned: all.length,
  };
}
/** Exhaustive namespace inventory for forget-all, including ambiguous writes. */
export async function listAllMemoryIds(
  env: MemoryEnv,
  args: { user_id: string; tenant_binding: string },
): Promise<string[]> {
  return (
    await inventoryRecords(
      env,
      buildNamespace(args.user_id, args.tenant_binding),
    )
  ).map((m) => m.vector_id);
}
export function rankByTypeWeight(
  matches: AgentMemoryMatch[],
): AgentMemoryMatch[] {
  return matches
    .map((m) => ({
      ...m,
      weighted_score: m.score * (MEMORY_TYPE_WEIGHTS[m.metadata.type] ?? 1),
    }))
    .sort((a, b) => b.weighted_score - a.weighted_score);
}
