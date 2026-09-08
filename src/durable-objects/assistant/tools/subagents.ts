/**
 * `spawn_subagents` — DurableClaw's fan-out tool.
 *
 * The call is NON-BLOCKING by design. It returns a batch id, not results:
 * awaiting the work would pin the coordinator's wall clock and stall the
 * user's live chat. Findings arrive on a later turn via the batch synthesis
 * job, which posts them into this conversation.
 *
 * The `batch_id` returned to the model is for LOG CORRELATION ONLY. There is
 * no lookup endpoint: `runBatchSynthesis` deletes the ledger rows once it has
 * posted findings, so a finished batch and a nonexistent one are
 * indistinguishable from the outside. Nothing here — or in the tool
 * description below — should imply the model can poll or check on a batch id
 * later.
 */
import { defineTool } from "../../../action-library/helpers";
import type { SubagentTier } from "../subagentLedger";

/**
 * Ceiling on tasks per call. The ledger's 100-slot cap (`MAX_CONCURRENT_SUBAGENTS`
 * in `subagentLedger.ts`) is the backstop, not the primary defence — this is
 * the first line, against a model that misreads a request and asks for
 * hundreds in one call.
 *
 * Also load-bearing against a stall: `NanoChatAgent.spawnSubagentBatch` makes
 * exactly one batch per call, and `assistant.spawnSubagentsTool.test.ts`
 * asserts `MAX_TASKS_PER_CALL <= DISPATCH_PUMP_LIMIT` (the coordinator's
 * per-pump dispatch ceiling). Keeping this at or below that limit is what
 * guarantees a batch can always drain in a single dispatch pump round —
 * raise it past that limit and a batch whose dispatches all fail would strand
 * its remainder until the 5-minute batch deadline instead of redraining on
 * the next pump.
 */
export const MAX_TASKS_PER_CALL = 20;

const TIERS: readonly string[] = ["foreground", "background"];

export type SpawnFn = (args: {
  origin: string;
  conversation_id: string | null;
  tasks: Array<{ goal: string; tier: SubagentTier }>;
}) => Promise<{ batch_id: string; queued: number }>;

export interface SubagentToolContext {
  spawn: SpawnFn;
  conversation_id?: string;
}

export function createSubagentTools(ctx: SubagentToolContext) {
  return {
    spawn_subagents: defineTool<{
      tasks: Array<{ goal: string; tier?: string }>;
    }>({
      description:
        "Delegate independent pieces of research to parallel subagents. Use this when a question " +
        "needs several separate investigations that do not depend on each other. Subagents are " +
        "READ-ONLY: they search and read records, they cannot change anything. This returns " +
        "immediately with a batch id — the findings arrive in this conversation shortly afterwards, " +
        "so tell the user you are looking into it rather than waiting. The batch id is for your own " +
        "reference only; there is no way to look up or check on a batch later, so do not tell the " +
        "user you will check back on it.",
      properties: {
        tasks: {
          type: "array",
          description: `The investigations to run in parallel. At most ${MAX_TASKS_PER_CALL}.`,
          items: {
            type: "object",
            properties: {
              goal: {
                type: "string",
                description:
                  "One self-contained objective, written as an instruction. The subagent sees " +
                  "only this sentence, so it must carry its own context.",
              },
              tier: {
                type: "string",
                enum: ["foreground", "background"],
                description:
                  "'foreground' for work where accuracy matters and mistakes are costly; " +
                  "'background' (the default) for straightforward information gathering.",
              },
            },
            required: ["goal"],
          },
        },
      },
      required: ["tasks"],
      execute: async (input) => {
        const tasks = input?.tasks;
        if (!Array.isArray(tasks)) return "Error: tasks must be an array.";
        if (tasks.length === 0) {
          return "Error: provide at least one task to spawn.";
        }
        if (tasks.length > MAX_TASKS_PER_CALL) {
          return `Error: at most ${MAX_TASKS_PER_CALL} tasks per call; you asked for ${tasks.length}. Split the work across several calls.`;
        }
        for (const task of tasks) {
          if (!task || typeof task !== "object")
            return "Error: every task needs a non-empty goal.";
          if (task.tier && !TIERS.includes(task.tier)) {
            return `Error: unknown tier '${task.tier}'. Use 'foreground' or 'background'.`;
          }
          if (typeof task.goal !== "string" || !task.goal.trim()) {
            return "Error: every task needs a non-empty goal.";
          }
          if (task.goal.length > 32_000)
            return "Error: each goal must be at most 32,000 characters.";
        }

        try {
          const result = await ctx.spawn({
            origin: "chat",
            conversation_id: ctx.conversation_id ?? null,
            tasks: tasks.map((t) => ({
              goal: t.goal,
              // `||`, not `??`: the validation loop above treats an empty
              // string the same as an absent tier (falsy, so it skips the
              // enum check and falls through to the default here too).
              // `?? 'background'` would leave `''` as `''` — a value
              // `TIERS` never rejected but `ResearchSubagent`'s own strict
              // tier check does, which 400s the dispatch and settles the
              // WHOLE task 'failed'. Models do emit `""` for an omitted
              // optional enum.
              tier: (t.tier as SubagentTier) || "background",
            })),
          });
          return `Spawned ${result.queued} subagent(s) as batch ${result.batch_id}. Their findings will arrive in this conversation shortly.`;
        } catch (err) {
          // `spawnSubagentBatch` throws PRE-WRITE for a missing conversation_id
          // or an uninitialised context — nothing was queued, so "failed" is
          // simply true. But a SQL error inside `scheduleJob`/`pumpDispatch`
          // can reject AFTER the ledger rows and deadline already exist: the
          // batch is live and will still post findings later even though this
          // call is reporting a failure. The wording below has to be honest
          // about both cases at once rather than claiming nothing happened.
          return (
            `Error spawning subagents: ${(err as Error).message}. If any subagents already ` +
            "started before this error, their findings will still arrive in this conversation."
          );
        }
      },
    }),
  };
}
