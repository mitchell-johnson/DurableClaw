/**
 * The fixed toolset a subagent is allowed.
 *
 * Two invariants from the Stage 1 design are enforced here, and both are
 * enforced by OMISSION rather than by instruction — a model can ignore a
 * prompt, it cannot call a tool that is not in its ToolSet:
 *
 *   1. Subagents are READ-ONLY. Only the coordinator proposes actions, and
 *      proposals go through the human-reviewed action_runs flow.
 *   2. Subagents cannot spawn subagents. 100 subagents each spawning 100
 *      would be 10,000; the depth limit is what makes the per-user cap
 *      meaningful.
 *
 * Build only the retrieval catalogue, then apply a fixed final allowlist.
 * The final filter is independent of factory include options, so accidentally
 * adding a mutation or delegation tool to retrieval cannot widen this surface.
 */
import type { ToolSet } from "ai";
import type { RetrievalContext } from "../../services/retrieval/types";
import {
  createRetrievalTools,
  createMemoryRetrievalTool,
} from "../../action-library/tools/retrieval";

/**
 * Every tool id a subagent may hold. Read-only by construction: retrieval and
 * schema introspection only. `search_memory` appears here but is additionally
 * gated on a retrieval context being available.
 */
export const SUBAGENT_TOOL_IDS: readonly string[] = [
  "search_records",
  "search_vectors",
  "get_entity",
  "get_schema",
  "search_memory",
] as const;

export function buildSubagentToolset(args: {
  retrievalContext?: RetrievalContext;
}): ToolSet {
  const catalogue: Record<string, unknown> = {};

  if (args.retrievalContext) {
    Object.assign(
      catalogue,
      createRetrievalTools(args.retrievalContext, {
        include: [
          "search_vectors",
          "search_records",
          "get_entity",
          "get_schema",
        ],
      }),
      createMemoryRetrievalTool(args.retrievalContext),
    );
  }

  const allowed: Record<string, unknown> = {};
  for (const id of SUBAGENT_TOOL_IDS) {
    if (id in catalogue) allowed[id] = catalogue[id];
  }
  return allowed as ToolSet;
}
