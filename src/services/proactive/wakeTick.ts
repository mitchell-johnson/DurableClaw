import {
  beginWakeObservation,
  setWakeObservationPhase,
  finishWakeObservation,
  settleInterruptedWake,
} from "./wakeRecovery";
import type { ToolSet } from "ai";
import type { Env } from "../../types/env";
import type { SqlExecLike } from "../../durable-objects/assistant/memory";
import type { SubagentTier } from "../../durable-objects/assistant/subagentLedger";
import { CHAT_MODEL } from "../../config";
import { logError, logInfo, logWarn } from "../../telemetry/logger";
import { runToolLoop } from "../../action-library/loop";
import { defineTool } from "../../action-library/helpers";
import type {
  Signal,
  ObserverContext,
  ObserverDb,
  ObserverUser,
} from "./types";
import { readObserverCursor, writeObserverCursor } from "./cursors";
import { createObservers } from "./observers";
import {
  filterLiveSignals,
  recordSignals,
  resolveSignalDedupeTtlMs,
  sweepExpiredSignals,
} from "./dedupe";
import {
  bumpDailyUsage,
  dayUtc,
  readDailyUsage,
  resolveBudgetLimits,
} from "./budget";
import { createWakeOutputs, resolveWakeNotificationCap } from "./outputs";
export type WakeRunStatus =
  "running" | "quiet" | "awaiting_batch" | "completed" | "failed";
const WAKE_RUN_PATCHABLE = [
  "status",
  "batch_id",
  "signal_count",
  "signals_json",
  "triage_text",
  "synthesis_text",
  "tasks_json",
  "tokens_in",
  "tokens_out",
  "error",
  "completed_at",
] as const;
export type WakeRunPatch = Partial<
  Record<(typeof WAKE_RUN_PATCHABLE)[number], string | number | null>
>;
export interface WakeRunRow {
  run_id: string;
  batch_id: string | null;
  trigger: string;
  status: string;
  signal_count: number | null;
  signals_json: string | null;
  triage_text: string | null;
  synthesis_text: string | null;
  tasks_json: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
}
export interface WakeTaskSnapshotEntry {
  task_id: string;
  goal: string;
  tier: string;
  status: string;
  created_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  result: unknown;
  error: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
}
export function insertWakeRun(
  sql: SqlExecLike,
  args: {
    run_id: string;
    trigger: string;
    status: WakeRunStatus;
    started_at: number;
  },
): void {
  sql.exec(
    `INSERT INTO wake_runs (run_id, trigger, status, started_at) VALUES (?, ?, ?, ?)`,
    args.run_id,
    args.trigger,
    args.status,
    args.started_at,
  );
}
export function updateWakeRun(
  sql: SqlExecLike,
  run_id: string,
  patch: WakeRunPatch,
): void {
  const keys = Object.keys(patch) as Array<keyof WakeRunPatch>;
  if (keys.length === 0) return;
  for (const key of keys) {
    if (!(WAKE_RUN_PATCHABLE as readonly string[]).includes(key)) {
      throw new Error(`updateWakeRun cannot set unknown column '${key}'`);
    }
  }
  const assignments = keys.map((k) => `${k} = ?`).join(", ");
  sql.exec(
    `UPDATE wake_runs SET ${assignments} WHERE run_id = ?`,
    ...keys.map((k) => patch[k] ?? null),
    run_id,
  );
}
function readWakeRunWhere(
  sql: SqlExecLike,
  whereSql: string,
  param: string,
): WakeRunRow | null {
  const rows = sql.exec(whereSql, param).toArray() as unknown as WakeRunRow[];
  return rows[0] ?? null;
}
export function getWakeRun(
  sql: SqlExecLike,
  run_id: string,
): WakeRunRow | null {
  return readWakeRunWhere(
    sql,
    "SELECT * FROM wake_runs WHERE run_id = ?",
    run_id,
  );
}
export function findWakeRunByBatchId(
  sql: SqlExecLike,
  batch_id: string,
): WakeRunRow | null {
  return readWakeRunWhere(
    sql,
    `SELECT * FROM wake_runs WHERE batch_id = ? ORDER BY started_at DESC LIMIT 1`,
    batch_id,
  );
}
export const MAX_WAKE_TASKS_PER_CALL = 20;
export function createWakeSpawnTool(
  spawn: (
    tasks: Array<{
      goal: string;
      tier: SubagentTier;
    }>,
  ) => Promise<{
    batch_id: string;
    queued: number;
  }>,
  spawnedBatch: {
    id: string | null;
    queued: number;
  },
): ToolSet {
  const tiers: readonly string[] = ["foreground", "background"];
  return {
    spawn_subagents: defineTool<{
      tasks: Array<{
        goal: string;
        tier?: string;
      }>;
    }>({
      description:
        "Delegate independent investigations to parallel subagents before reporting. Use this when " +
        "several of the detected changes deserve detail before the user should be interrupted. " +
        "Subagents are READ-ONLY. This returns immediately; the findings are synthesized into your " +
        "final report afterwards.",
      properties: {
        tasks: {
          type: "array",
          description: `The investigations to run in parallel. At most ${MAX_WAKE_TASKS_PER_CALL}.`,
          items: {
            type: "object",
            properties: {
              goal: {
                type: "string",
                description:
                  "One self-contained objective, written as an instruction. The subagent sees only this sentence.",
              },
              tier: {
                type: "string",
                enum: ["foreground", "background"],
                description:
                  "'foreground' where accuracy matters; 'background' (the default) for routine gathering.",
              },
            },
            required: ["goal"],
          },
        },
      },
      required: ["tasks"],
      execute: async (input) => {
        const tasks = input.tasks ?? [];
        if (tasks.length === 0)
          return "Error: provide at least one task to spawn.";
        if (tasks.length > MAX_WAKE_TASKS_PER_CALL) {
          return `Error: at most ${MAX_WAKE_TASKS_PER_CALL} tasks per call; you asked for ${tasks.length}.`;
        }
        for (const task of tasks) {
          if (task.tier && !tiers.includes(task.tier)) {
            return `Error: unknown tier '${task.tier}'. Use 'foreground' or 'background'.`;
          }
          if (!task.goal || !task.goal.trim())
            return "Error: every task needs a non-empty goal.";
        }
        try {
          const result = await spawn(
            tasks.map((t) => ({
              goal: t.goal,
              tier: (t.tier as SubagentTier) || "background",
            })),
          );
          if (!result.batch_id || result.queued <= 0) {
            logWarn("agent.wake.spawn.phantom_batch_ignored", {
              "agent.wake.spawned_reported": result.queued,
              "agent.subagent.batch_id": result.batch_id ?? null,
            });
            return "Error: no investigators were queued; continuing without fan-out.";
          }
          spawnedBatch.id = result.batch_id;
          spawnedBatch.queued = result.queued;
          return `Spawned ${result.queued} investigator(s). Their findings will be synthesized when they finish.`;
        } catch (err) {
          return `Error spawning investigators: ${(err as Error).message}`;
        }
      },
    }),
  } as ToolSet;
}
const SALIENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
export const MAX_TRIAGE_DIGEST_SIGNALS = 25;
export function buildTriageDigest(signals: Signal[]): string {
  const ordered = [...signals].sort((a, b) => {
    const rank =
      (SALIENCE_RANK[a.salience] ?? 3) - (SALIENCE_RANK[b.salience] ?? 3);
    return rank !== 0 ? rank : b.occurred_at - a.occurred_at;
  });
  const shown = ordered.slice(0, MAX_TRIAGE_DIGEST_SIGNALS);
  const lines = shown.map(
    (s, i) =>
      `${i + 1}. [${s.salience.toUpperCase()}] (${s.kind}) ${s.entity_type} ${s.entity_id} — ${s.summary}`,
  );
  const hidden = ordered.length - shown.length;
  if (hidden > 0)
    lines.push(
      `${shown.length + 1}. (+${hidden} further lower-priority changes not listed)`,
    );
  return lines.join("\n");
}
function buildTriageSystem(args: {
  userName?: string;
  organizationName?: string;
  personaText?: {
    identity_override: string | null;
    persona: string | null;
  } | null;
}): string {
  const who = args.userName ?? "the user";
  const org = args.organizationName ? ` at ${args.organizationName}` : "";
  const personaParts: string[] = [];
  if (args.personaText?.identity_override)
    personaParts.push(args.personaText.identity_override);
  if (args.personaText?.persona) personaParts.push(args.personaText.persona);
  const personaBlock =
    personaParts.length > 0
      ? `\n\nHow you present yourself:\n${personaParts.join("\n")}\n`
      : "";
  return (
    `You are DurableClaw, an AI assistant working for ${who}${org}.${personaBlock}` +
    ` This is a PROACTIVE BACKGROUND WAKE: nobody asked you anything. You scanned the workspace on a ` +
    `schedule and found the changes listed below.\n\n` +
    `Decide what genuinely deserves the user's attention. You may:\n` +
    `- use search_memory to recall their preferences and prior instructions,\n` +
    `- use spawn_subagents to gather detail on anything unclear before it is worth mentioning.\n\n` +
    `Then reply with a short plain-text digest: lead with whatever matters most, say plainly why each ` +
    `item is worth their time, and drop noise entirely rather than summarising it. If nothing warrants ` +
    `attention beyond the list itself, say so in one line. Do not invent changes that are not listed.`
  );
}
export const WAKE_TRIGGER = "alarm";
export interface SpawnTasksFn {
  (
    tasks: Array<{
      goal: string;
      tier: SubagentTier;
    }>,
    runId: string,
  ): Promise<{
    batch_id: string;
    queued: number;
  }>;
}
export interface WakeTickDeps {
  env: Env;
  sql: SqlExecLike;
  transactionSync: <T>(callback: () => T) => T;
  tenantDB: ObserverDb | undefined;
  user: ObserverUser;
  organizationId: string;
  userName?: string;
  organizationName?: string;
  personaText?: {
    identity_override: string | null;
    persona: string | null;
  } | null;
  memoryTools: ToolSet;
  spawnTasks: SpawnTasksFn;
  now: number;
}
export type WakeTickOutcome =
  "quiet" | "degraded" | "spawned" | "completed" | "failed";
export interface WakeTickResult {
  outcome: WakeTickOutcome;
  run_id: string;
  signal_count: number;
  swept: number;
  spawned?: number;
  batch_id?: string;
  duration_ms: number;
}
export async function runWakePassA(
  deps: WakeTickDeps,
): Promise<WakeTickResult> {
  const startedAt = deps.now;
  const run_id = `wake_${crypto.randomUUID()}`;
  const durationMs = () => Math.max(0, Date.now() - startedAt);
  // Only one observation window may advance the shared cursors at a time.
  if (
    deps.sql
      .exec("SELECT run_id FROM wake_observation_windows LIMIT 1")
      .toArray().length
  )
    throw new Error("A wake observation pass is already active");
  deps.transactionSync(() => {
    insertWakeRun(deps.sql, {
      run_id,
      trigger: WAKE_TRIGGER,
      status: "running",
      started_at: startedAt,
    });
    beginWakeObservation(
      deps.sql,
      run_id,
      createObservers().map((observer) => observer.name),
    );
  });
  const pendingCursors = new Map<string, string>();
  let fresh: Signal[] = [];
  let swept = 0;
  try {
    swept = sweepExpiredSignals(deps.sql, deps.now);
    if (!deps.tenantDB) {
      logWarn("agent.wake.observers.skipped", {
        "user.id": deps.user.id,
        "agent.wake.reason": "no_tenant_binding",
      });
    } else {
      const ctx: ObserverContext = {
        db: deps.tenantDB,
        securedDb: deps.tenantDB,
        workspaceId: deps.organizationId,
        user: deps.user,
        readCursor: (name) =>
          Promise.resolve(readObserverCursor(deps.sql, name)),
        writeCursor: (name, value) => {
          pendingCursors.set(name, value);
          return Promise.resolve();
        },
        nowMs: deps.now,
      };
      const collected: Signal[] = [];
      for (const observer of createObservers()) {
        try {
          collected.push(...(await observer.observe(ctx)));
        } catch (err) {
          logError("agent.wake.observer.failed", err as Error, {
            "user.id": deps.user.id,
            "agent.wake.observer": observer.name,
          });
        }
      }
      fresh = filterLiveSignals(deps.sql, collected);
    }
    deps.transactionSync(() => {
      updateWakeRun(deps.sql, run_id, {
        signal_count: fresh.length,
        signals_json: JSON.stringify(fresh),
      });
      setWakeObservationPhase(deps.sql, run_id, "triage");
      for (const [name, value] of pendingCursors)
        writeObserverCursor(deps.sql, name, value, deps.now);
      recordSignals(
        deps.sql,
        fresh,
        Date.now(),
        resolveSignalDedupeTtlMs(deps.env),
      );
    });
  } catch (err) {
    deps.transactionSync(() =>
      settleInterruptedWake(
        deps.sql,
        run_id,
        Date.now(),
        `observer pass failed: ${(err as Error).message}`,
      ),
    );
    return {
      outcome: "failed",
      run_id,
      signal_count: 0,
      swept,
      duration_ms: durationMs(),
    };
  }
  try {
    updateWakeRun(deps.sql, run_id, {
      signal_count: fresh.length,
      signals_json: JSON.stringify(fresh),
    });
    if (fresh.length === 0) {
      updateWakeRun(deps.sql, run_id, {
        status: "quiet",
        completed_at: Date.now(),
      });
      finishWakeObservation(deps.sql, run_id);
      return {
        outcome: "quiet",
        run_id,
        signal_count: 0,
        swept,
        duration_ms: durationMs(),
      };
    }
    const limits = resolveBudgetLimits(deps.env);
    const usage = readDailyUsage(deps.sql, dayUtc(deps.now));
    const budgetExhausted =
      usage.triage_turns >= limits.maxTriageTurns ||
      usage.subagent_spawns >= limits.maxSubagentSpawns;
    if (budgetExhausted) {
      const cap = resolveWakeNotificationCap(deps.env);
      const ranked = [...fresh]
        .sort(
          (a, b) =>
            (SALIENCE_RANK[a.salience] ?? 3) - (SALIENCE_RANK[b.salience] ?? 3),
        )
        .filter((s) => s.salience === "high");
      const capped = ranked.slice(0, cap);
      const overflowCount = Math.max(0, ranked.length - capped.length);
      setWakeObservationPhase(deps.sql, run_id, "publishing");
      const outputs = await createWakeOutputs({
        signals: capped,
        overflowCount,
        synthesisText: null,
        db: deps.tenantDB as unknown as Parameters<
          typeof createWakeOutputs
        >[0]["db"],
        userId: deps.user.id,
        organizationId: deps.organizationId,
        env: deps.env,
        nowMs: Date.now(),
      });
      updateWakeRun(deps.sql, run_id, {
        status: "completed",
        triage_text:
          `Daily budget reached — skipped AI triage. ${capped.length} high-priority change(s) surfaced directly` +
          (overflowCount > 0 ? `, ${overflowCount} more collapsed.` : "."),
        synthesis_text: `${outputs.notifications_created} notification(s), ${outputs.proposals_created} proposal(s).`,
        completed_at: Date.now(),
      });
      finishWakeObservation(deps.sql, run_id);
      logInfo("agent.wake.tick.degraded", {
        "user.id": deps.user.id,
        "agent.wake.run_id": run_id,
        "agent.wake.signal_count": fresh.length,
        "agent.wake.degraded": true,
        "agent.wake.high_salience": ranked.length,
        "gen_ai.usage.input_tokens": 0,
        "gen_ai.usage.output_tokens": 0,
      });
      return {
        outcome: "degraded",
        run_id,
        signal_count: fresh.length,
        swept,
        duration_ms: durationMs(),
      };
    }
    bumpDailyUsage(deps.sql, dayUtc(deps.now), { triageTurns: 1 });
    const spawnedBatch: {
      id: string | null;
      queued: number;
    } = { id: null, queued: 0 };
    const tools: ToolSet = {
      ...createWakeSpawnTool(
        (tasks) => deps.spawnTasks(tasks, run_id),
        spawnedBatch,
      ),
      ...deps.memoryTools,
    };
    const result = await runToolLoop({
      env: deps.env,
      model: CHAT_MODEL,
      system: buildTriageSystem({
        userName: deps.userName,
        organizationName: deps.organizationName,
        personaText: deps.personaText ?? null,
      }),
      messages: [{ role: "user", content: buildTriageDigest(fresh) }],
      tools,
      maxSteps: 6,
      telemetryTag: "agent_wake_triage",
    });
    updateWakeRun(deps.sql, run_id, {
      triage_text: result.text || "(triage produced no text)",
      tokens_in: result.usage?.inputTokens ?? null,
      tokens_out: result.usage?.outputTokens ?? null,
    });
    // Admission, association and charging happened before dispatch. Read durable truth;
    // a provider can fail after admission, or a repeated tool call can reuse the batch.
    const admitted = getWakeRun(deps.sql, run_id)?.batch_id;
    if (admitted) {
      finishWakeObservation(deps.sql, run_id);
      return {
        outcome: "spawned",
        run_id,
        signal_count: fresh.length,
        swept,
        spawned: spawnedBatch.queued,
        batch_id: admitted,
        duration_ms: durationMs(),
      };
    }
    updateWakeRun(deps.sql, run_id, {
      status: "completed",
      completed_at: Date.now(),
    });
    finishWakeObservation(deps.sql, run_id);
    return {
      outcome: "completed",
      run_id,
      signal_count: fresh.length,
      swept,
      duration_ms: durationMs(),
    };
  } catch (err) {
    deps.transactionSync(() =>
      settleInterruptedWake(
        deps.sql,
        run_id,
        Date.now(),
        (err as Error).message,
      ),
    );
    const admitted = getWakeRun(deps.sql, run_id)?.batch_id;
    if (admitted)
      return {
        outcome: "spawned",
        run_id,
        batch_id: admitted,
        signal_count: fresh.length,
        swept,
        duration_ms: durationMs(),
      };
    return {
      outcome: "failed",
      run_id,
      signal_count: fresh.length,
      swept,
      duration_ms: durationMs(),
    };
  }
}
