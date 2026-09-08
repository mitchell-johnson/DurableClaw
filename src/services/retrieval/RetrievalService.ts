import type { RetrievalContext, SemanticHit, RetrievalAdapter } from "./types";
import { workspacePrefix, readWorkspaceFile } from "../../storage/workspace";
import { authorizePrincipal } from "../../auth";
import { buildNamespace, queryMemory } from "../../utils/memoryClient";
export const MAX_VECTORIZE_TOPK = 50;
export class WorkspaceRetrievalAdapter implements RetrievalAdapter {
  constructor(private ctx: RetrievalContext) {}
  async search(query: string, limit: number): Promise<SemanticHit[]> {
    const prefix = workspacePrefix(
      this.ctx.principal.userId,
      this.ctx.tenantBinding,
    );
    const found: SemanticHit[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ctx.env.WORKSPACE.list({
        prefix,
        limit: 100,
        cursor,
      });
      for (const f of page.objects) {
        const name = f.key.slice(prefix.length);
        if (name.toLowerCase().includes(query.toLowerCase()))
          found.push({
            entityId: name,
            entityType: "file",
            score: 1,
            metadata: { name, size: f.size },
          });
        if (found.length >= limit) return found;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && found.length < limit);
    return found;
  }
  async authorize(hits: SemanticHit[]): Promise<SemanticHit[]> {
    await authorizePrincipal(
      this.ctx.env,
      this.ctx.principal.userId,
      this.ctx.tenantBinding,
    );
    return hits.filter(
      (h) =>
        h.entityType === "file" &&
        !h.entityId.startsWith("/") &&
        !h.entityId.split("/").includes(".."),
    );
  }
  async hydrate(hit: SemanticHit) {
    return {
      entity_type: "file",
      entity_id: hit.entityId,
      content: await readWorkspaceFile(
        this.ctx.env,
        this.ctx.principal.userId,
        this.ctx.tenantBinding,
        hit.entityId,
      ),
    };
  }
  async schema() {
    return {
      file: {
        id: "workspace-relative path",
        fields: ["name", "size", "content"],
      },
      search:
        "Pass a filename substring to search_records; use search_vectors for indexed document content.",
    };
  }
}
export class RetrievalService {
  private adapter: RetrievalAdapter;
  constructor(
    private ctx: RetrievalContext,
    adapter?: RetrievalAdapter,
  ) {
    this.adapter = adapter || new WorkspaceRetrievalAdapter(ctx);
  }
  async structuredSearch(input: {
    query?: string;
    sql?: string;
    maxRows?: number;
  }) {
    const limit = Math.max(1, Math.min(input.maxRows || 20, 50));
    return this.adapter.authorize(
      await this.adapter.search(input.query || input.sql || "", limit),
    );
  }
  async semanticSearch(input: {
    query: string;
    topK?: number;
    rerank?: boolean;
  }): Promise<SemanticHit[]> {
    const limit = Math.max(1, Math.min(input.topK || 10, 50));
    if (!this.ctx.env.DOCUMENT_INDEX)
      return this.structuredSearch({ query: input.query, maxRows: limit });
    const embedding = (await this.ctx.env.AI.run("@cf/baai/bge-m3", {
      text: [input.query],
    })) as { data: number[][] };
    const namespace = buildNamespace(
      this.ctx.principal.userId,
      this.ctx.tenantBinding,
    );
    const results = await this.ctx.env.DOCUMENT_INDEX.query(embedding.data[0], {
      namespace,
      topK: 50,
      returnMetadata: "all",
      filter: { user_namespace: { $eq: namespace } },
    });
    let hits = await this.adapter.authorize(
      results.matches
        .filter((m) => m.metadata?.user_namespace === namespace)
        .map((m) => ({
          entityId: String(m.metadata?.path || ""),
          entityType: "file",
          score: m.score,
          metadata: m.metadata || {},
        })),
    );
    if (input.rerank && hits.length) {
      const rerankInput = {
        query: input.query,
        contexts: hits.map((h) => ({
          text: String(h.metadata.text || h.entityId),
        })),
      };
      const ranked = (await this.ctx.env.AI.run(
        "@cf/baai/bge-reranker-base",
        rerankInput,
      )) as { response: { id: number; score: number }[] };
      hits = ranked.response
        .filter((x) => hits[x.id])
        .map((x) => ({ ...hits[x.id], score: x.score }));
    }
    return (await this.adapter.authorize(hits)).slice(0, limit);
  }
  async getEntity(entityType: string, entityId: string) {
    const hits = await this.adapter.authorize([
      { entityType, entityId, score: 1, metadata: {} },
    ]);
    if (!hits.length) throw new Error("Record unavailable");
    return this.adapter.hydrate(hits[0]);
  }
  async getSchema() {
    return this.adapter.schema();
  }
  async searchMemory(args: {
    query: string;
    topK?: number;
    typeFilter?: Parameters<typeof queryMemory>[1]["typeFilter"];
  }) {
    await authorizePrincipal(
      this.ctx.env,
      this.ctx.principal.userId,
      this.ctx.tenantBinding,
    );
    return queryMemory(this.ctx.env, {
      user_id: this.ctx.principal.userId,
      tenant_binding: this.ctx.tenantBinding,
      query_text: args.query,
      topK: args.topK,
      typeFilter: args.typeFilter,
    });
  }
}
