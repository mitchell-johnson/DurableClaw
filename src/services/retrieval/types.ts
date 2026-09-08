import type { Env } from "../../types";
import type { UserPermission } from "../../types/auth";
export interface RetrievalContext {
  env: Env;
  tenantBinding: string;
  tenantDB: D1Database;
  principal: {
    userId: string;
    userRole: string;
    permissions: UserPermission[];
  };
  telemetryTag: string;
  filterMemoryIds?: (ids: string[]) => Promise<string[]>;
}
export interface SemanticHit {
  entityId: string;
  entityType: string;
  score: number;
  metadata: Record<string, unknown>;
}
/** Authorization is applied before reranking and hydration, and rechecked after asynchronous search. */
export interface RetrievalAdapter {
  search(query: string, limit: number): Promise<SemanticHit[]>;
  authorize(hits: SemanticHit[]): Promise<SemanticHit[]>;
  hydrate(hit: SemanticHit): Promise<unknown>;
  schema(): Promise<unknown>;
}
