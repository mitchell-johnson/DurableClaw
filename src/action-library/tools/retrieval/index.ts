import type { ToolSet } from "ai";
import { defineTool, sanitizeToolOutput } from "../../helpers";
import {
  RetrievalService,
  MAX_VECTORIZE_TOPK,
} from "../../../services/retrieval/RetrievalService";
import type {
  RetrievalContext,
  SemanticHit,
} from "../../../services/retrieval/types";
import {
  getMemoriesByIds,
  buildNamespace,
  type AgentMemoryMatch,
  type AgentMemoryType,
} from "../../../utils/memoryClient";
import {
  collectExpansionVectorIds,
  ENTITY_EXPANSION_SEED,
  ENTITY_LINK_BOOST,
  EXPANSION_SCORE_MULTIPLIER,
  type SqlExecLike,
} from "../../../durable-objects/assistant/memory";
import { logWarn, logError } from "../../../telemetry/logger";
import { filterWarmMemoryIds } from "../../../durable-objects/assistant/dreaming";
const TOOL_RESULT_LIMIT = 20;
function clampTopK(requested: number | undefined, fallback: number): number {
  const k = Number.isFinite(requested) ? (requested as number) : fallback;
  return Math.max(0, Math.min(k, TOOL_RESULT_LIMIT));
}
function compactHit(hit: SemanticHit): Record<string, unknown> {
  const md = hit.metadata ?? {};
  return {
    metadata: md,
    entity_type: hit.entityType,
    entity_id: hit.entityId,
    score: Number(hit.score.toFixed(4)),
    name:
      (md.name as string | undefined) ??
      (md.title as string | undefined) ??
      undefined,
    status: md.status as string | undefined,
  };
}
function isValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^SQL validation failed:|^Table not allowed in retrieval SQL:/.test(
    message,
  );
}
function toolError(what: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeToolOutput(`${what} unavailable: ${message}`);
}
function ok(payload: unknown): string {
  return sanitizeToolOutput(JSON.stringify(payload));
}
export function createRetrievalTools(
  ctx: RetrievalContext,
  options?: {
    include?: Array<
      "search_records" | "search_vectors" | "get_entity" | "get_schema"
    >;
  },
): ToolSet {
  const service = new RetrievalService(ctx);
  const all: ToolSet = {
    search_records: defineTool<{
      query: string;
      max_rows?: number;
    }>({
      description: "Find private workspace files by filename substring.",
      properties: { query: { type: "string" }, max_rows: { type: "number" } },
      required: ["query"],
      execute: async (i) => {
        try {
          return ok(
            (
              await service.structuredSearch({
                query: i.query,
                maxRows: i.max_rows,
              })
            ).map(compactHit),
          );
        } catch (e) {
          return toolError("File search", e);
        }
      },
    }),
    search_vectors: defineTool<{
      query: string;
      top_k?: number;
      rerank?: boolean;
    }>({
      description:
        "Semantic search over indexed workspace documents; falls back to filename search when no document index is configured.",
      properties: {
        query: { type: "string" },
        top_k: { type: "number" },
        rerank: { type: "boolean" },
      },
      required: ["query"],
      execute: async (i) => {
        try {
          return ok(
            (
              await service.semanticSearch({
                query: i.query,
                topK: i.top_k,
                rerank: i.rerank,
              })
            ).map(compactHit),
          );
        } catch (e) {
          return toolError("Semantic search", e);
        }
      },
    }),
    get_entity: defineTool<{
      entity_type: string;
      entity_id: string;
    }>({
      description:
        "Read a private workspace file by its relative path. entity_type must be file.",
      properties: {
        entity_type: { type: "string", enum: ["file"] },
        entity_id: { type: "string" },
      },
      required: ["entity_type", "entity_id"],
      execute: async (i) => {
        try {
          return ok(await service.getEntity(i.entity_type, i.entity_id));
        } catch (e) {
          return toolError("File read", e);
        }
      },
    }),
    get_schema: defineTool<Record<string, never>>({
      description:
        "Describe the available workspace record types and search interface.",
      properties: {},
      execute: async () => ok(await service.getSchema()),
    }),
  };
  return options?.include
    ? Object.fromEntries(options.include.map((k) => [k, all[k]]))
    : all;
}
function formatMemory(m: AgentMemoryMatch, related: boolean) {
  return {
    type: m.metadata.type,
    content: m.metadata.content_preview,
    created_at: m.metadata.created_at,
    score: Number(m.weighted_score.toFixed(4)),
    ...(related
      ? { related_via: "linked record from another conversation" }
      : {}),
  };
}
async function expandByEntityLinks(
  ctx: RetrievalContext,
  sql: SqlExecLike | undefined,
  semantic: AgentMemoryMatch[],
): Promise<AgentMemoryMatch[]> {
  if (!sql || semantic.length === 0) return [];
  try {
    const ranked = [...semantic].sort(
      (a, b) => b.weighted_score - a.weighted_score,
    );
    const seedIds = ranked
      .slice(0, ENTITY_EXPANSION_SEED)
      .map((m) => m.vector_id);
    const alreadyHave = new Set(semantic.map((m) => m.vector_id));
    const ids = collectExpansionVectorIds(sql, seedIds, alreadyHave);
    if (ids.length === 0) return [];
    const expanded = await getMemoriesByIds(ctx.env, ids);
    const namespace = buildNamespace(ctx.principal.userId, ctx.tenantBinding);
    return expanded
      .filter((m) => m.metadata.user_namespace === namespace)
      .map((m) => ({
        ...m,
        weighted_score:
          m.weighted_score * EXPANSION_SCORE_MULTIPLIER + ENTITY_LINK_BOOST,
      }));
  } catch (error) {
    logWarn(
      "memory entity-link expansion failed; falling back to semantic recall",
      {
        "retrieval.tag": ctx.telemetryTag,
        "error.message": error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  }
}
export function createMemoryRetrievalTool(
  ctx: RetrievalContext,
  options?: {
    sql?: SqlExecLike;
  },
): ToolSet {
  const service = new RetrievalService(ctx);
  return {
    search_memory: defineTool<{
      query: string;
      top_k?: number;
      types?: string[];
    }>({
      description:
        'Search your long-term memory of this user: their preferences, prior instructions, and context from earlier conversations. Use when the request implies something you were told before ("the usual filters", "like last time").',
      properties: {
        query: { type: "string" },
        top_k: { type: "number", description: "Max memories (default 8)." },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict to memory types: raw, summary, memory, tool_call, insight.",
        },
      },
      required: ["query"],
      execute: async (input) => {
        try {
          const limit = clampTopK(input.top_k, 8);
          let semantic = await service.searchMemory({
            query: input.query,
            topK: limit ? MAX_VECTORIZE_TOPK : 0,
            typeFilter: input.types as AgentMemoryType[] | undefined,
          });
          const filterWarm = async (matches: AgentMemoryMatch[]) => {
            const ids = matches.map((match) => match.vector_id);
            const allowed = new Set(
              options?.sql
                ? filterWarmMemoryIds(options.sql, ids)
                : ctx.filterMemoryIds
                  ? await ctx.filterMemoryIds(ids)
                  : [],
            );
            return matches.filter((match) => allowed.has(match.vector_id));
          };
          semantic = await filterWarm(semantic);
          let related = await expandByEntityLinks(ctx, options?.sql, semantic);
          const allowed = new Set(
            (await filterWarm([...semantic, ...related])).map(
              (match) => match.vector_id,
            ),
          );
          semantic = semantic.filter((match) => allowed.has(match.vector_id));
          related = related.filter((match) => allowed.has(match.vector_id));
          const memories = [
            ...semantic.map((m) => formatMemory(m, false)),
            ...related.map((m) => formatMemory(m, true)),
          ]
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          const relatedCount = memories.filter(
            (memory) => memory.related_via,
          ).length;
          const semanticCount = memories.length - relatedCount;
          return ok({
            memories,
            summary:
              `${semanticCount} memor${semanticCount === 1 ? "y" : "ies"} recalled` +
              (relatedCount > 0
                ? `, plus ${relatedCount} linked to the same records from other conversations.`
                : "."),
          });
        } catch (error) {
          return toolError("memory search", error);
        }
      },
    }),
  };
}
