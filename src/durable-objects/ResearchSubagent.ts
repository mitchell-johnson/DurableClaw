/**
 * One task per Durable Object. Dispatch persists work and returns 202; the
 * alarm owns setup, generation, and durable result delivery independently of
 * the coordinator request. External awaits allow other requests to interleave,
 * so cancellation is explicit and results are persisted before callback I/O.
 * Completed generation is never repeated to retry delivery. Cancellation
 * tombstones expire after a bounded period, covering cancel-before-dispatch.
 */
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { CHAT_MODEL, BACKGROUND_MODEL } from "../config";
import { runToolLoop, ToolLoopGenerationError } from "../action-library/loop";
import { buildSubagentToolset } from "./assistant/subagentTools";
import { buildRetrievalContextFor } from "./assistant/principal";
import {
  createInternalAuthHeaders,
  readInternalAuth,
} from "../utils/internalAuth";
import { logWarn, logError } from "../telemetry/logger";
import type { Env } from "../types";
import { createDurableObjectTelemetry } from "../telemetry/durable-object";

/** Step ceiling for one subagent turn. Deliberately tighter than DurableClaw's. */
const SUBAGENT_MAX_STEPS = 12;

const TASK_KEY = "task";
const CANCELLED_KEY = "cancelled";

const REPORT_KEY = "report_pending";
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const CALLBACK_TIMEOUT_MS = 5_000;
const MAX_REPORT_ATTEMPTS = 8;
const MAX_RESULT_CHARS = 32_000;
interface Cancellation {
  task_id: string;
  expires_at: number;
}
interface PendingReport {
  task: SubagentDispatch;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: number;
  expires_at: number;
  reported?: boolean;
}

/** Stop waiting for non-abortable bindings too; their late result is ignored. */
function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

export interface SubagentDispatch {
  task_id: string;
  batch_id: string;
  goal: string;
  tier: "foreground" | "background";
  toolset: string[];
  /** Absolute epoch ms — set by the coordinator as `now + budget`, not a duration. */
  deadline_at: number;
  /** Optional timing metadata from the coordinator ledger, epoch ms. */
  enqueued_at?: number;
  dispatched_at?: number;
  coordinator_do_name: string;
  context: {
    user_id: string;
    user_name: string;
    user_role: string;
    organization_id: string;
    tenant_binding: string;
  };
}

/**
 * Everything `/dispatch` accepts blind and `alarm()` later depends on. A
 * dispatch missing any of this dies inside `alarm()` as an opaque "task
 * failure" instead of a 400 the coordinator can act on immediately.
 */
function isValidContext(
  context: unknown,
): context is SubagentDispatch["context"] {
  if (!context || typeof context !== "object") return false;
  const c = context as Record<string, unknown>;
  return (
    typeof c.user_id === "string" &&
    c.user_id.length > 0 &&
    typeof c.user_name === "string" &&
    c.user_name.length > 0 &&
    typeof c.user_role === "string" &&
    c.user_role.length > 0 &&
    typeof c.organization_id === "string" &&
    c.organization_id.length > 0 &&
    typeof c.tenant_binding === "string" &&
    c.tenant_binding.length > 0
  );
}

export class ResearchSubagent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private activeController?: AbortController;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // /dispatch and /cancel are coordinator-only surfaces behind a
    // routing invariant. Require the HMAC envelope so a future catch-all
    // proxy cannot forge dispatches or cancel tasks it does not own.
    if (
      (url.pathname === "/dispatch" || url.pathname === "/cancel") &&
      request.method === "POST"
    ) {
      if (!(await readInternalAuth(request, this.env))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    if (url.pathname === "/dispatch" && request.method === "POST") {
      return this.handleDispatch(request);
    }
    if (url.pathname === "/cancel" && request.method === "POST") {
      return this.handleCancel(request);
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Persist and acknowledge. Nothing slow belongs in this method — the
   * coordinator is awaiting the response.
   */
  private async handleDispatch(request: Request): Promise<Response> {
    let task: SubagentDispatch;
    try {
      task = (await request.json()) as SubagentDispatch;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (
      typeof task?.task_id !== "string" ||
      !task.task_id ||
      task.task_id.length > 256 ||
      typeof task.batch_id !== "string" ||
      !task.batch_id ||
      task.batch_id.length > 256 ||
      typeof task.goal !== "string" ||
      !task.goal.trim() ||
      task.goal.length > 32_000 ||
      typeof task.coordinator_do_name !== "string" ||
      !task.coordinator_do_name ||
      task.coordinator_do_name.length > 1024 ||
      !isValidContext(task.context) ||
      (task.tier !== "foreground" && task.tier !== "background") ||
      // Both fields became load-bearing once alarm() started honouring them
      // (toolset intersection, deadline enforcement) — a dispatch missing
      // either now dies inside alarm() as an opaque failure instead of a
      // 400 the coordinator could have caught immediately.
      !Array.isArray(task.toolset) ||
      task.toolset.length === 0 ||
      task.toolset.length > 20 ||
      task.toolset.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 128,
      ) ||
      typeof task.deadline_at !== "number" ||
      !Number.isFinite(task.deadline_at)
    ) {
      return Response.json({ error: "Malformed dispatch" }, { status: 400 });
    }

    const principal = await readInternalAuth(request, this.env);
    if (
      !principal ||
      principal.userId !== task.context.user_id ||
      principal.organizationId !== task.context.organization_id ||
      principal.tenantBinding !== task.context.tenant_binding ||
      principal.role !== task.context.user_role
    ) {
      return Response.json({ error: "Principal mismatch" }, { status: 403 });
    }

    const cancelled = await this.state.storage.get<Cancellation>(CANCELLED_KEY);
    if (cancelled && cancelled.expires_at > Date.now()) {
      return Response.json(
        { accepted: false, cancelled: true },
        { status: 202 },
      );
    }
    // At-least-once dispatch must not replace work or reset the result outbox.
    const existing = await this.state.storage.get<SubagentDispatch>(TASK_KEY);
    const report = await this.state.storage.get<PendingReport>(REPORT_KEY);
    if (existing || report) {
      const owner = existing?.task_id ?? report?.task.task_id;
      if (owner !== task.task_id)
        return Response.json(
          { error: "Task already assigned" },
          { status: 409 },
        );
      // The previous request may have persisted the task and then failed
      // before setting its alarm. Repair that recovery path on duplicate ACK.
      await this.state.storage.setAlarm(Date.now());
      return Response.json({ accepted: true }, { status: 202 });
    }
    await this.state.storage.put(TASK_KEY, task);
    // Fire immediately, but on OUR alarm rather than in this request, so the
    // coordinator's await returns now.
    await this.state.storage.setAlarm(Date.now());

    return Response.json({ accepted: true }, { status: 202 });
  }

  private async handleCancel(request: Request): Promise<Response> {
    const task = await this.state.storage.get<SubagentDispatch>(TASK_KEY);
    if (task) {
      const principal = await readInternalAuth(request, this.env);
      if (
        !principal ||
        principal.userId !== task.context.user_id ||
        principal.organizationId !== task.context.organization_id ||
        principal.tenantBinding !== task.context.tenant_binding
      ) {
        return Response.json({ error: "Principal mismatch" }, { status: 403 });
      }
    }
    let body: { task_id?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      /* Legacy callers omitted the body. */
    }
    const taskId =
      typeof body?.task_id === "string" && body.task_id.length > 0
        ? body.task_id
        : task?.task_id;
    if (!taskId) return Response.json({ cancelled: false });
    if (task && task.task_id !== taskId)
      return Response.json({ error: "Task mismatch" }, { status: 409 });
    const cancellation: Cancellation = {
      task_id: taskId,
      expires_at: Date.now() + RETENTION_MS,
    };
    await this.state.storage.put(CANCELLED_KEY, cancellation);
    this.activeController?.abort(
      new DOMException("Subagent task cancelled", "AbortError"),
    );
    // Before dispatch this is an expiry alarm. A running/persisted task needs
    // an immediate report; its alarm will restore the tombstone expiry later.
    await this.state.storage.setAlarm(
      task ? Date.now() : cancellation.expires_at,
    );
    return Response.json({ cancelled: true });
  }

  private async cleanup(taskId?: string): Promise<void> {
    try {
      // Delete runnable input first. A failed bulk cleanup can then only retry
      // cheap cleanup or a previously persisted report, never generation.
      await this.state.storage.delete(TASK_KEY);
      const cancellation =
        await this.state.storage.get<Cancellation>(CANCELLED_KEY);
      if (cancellation && cancellation.expires_at > Date.now()) {
        await this.state.storage.delete(REPORT_KEY);
        await this.state.storage.setAlarm(cancellation.expires_at);
      } else {
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
      }
    } catch (error) {
      logError("ResearchSubagent storage cleanup failed", error as Error, {
        "do.name": "ResearchSubagent",
        "agent.subagent.task_id": taskId ?? "",
      });
      // Cleanup has its own durable retry even after the callback succeeded.
      await this.state.storage.setAlarm(Date.now() + 60_000);
    }
  }

  async alarm(): Promise<void> {
    const telemetry = createDurableObjectTelemetry(this.env, "agent.subagent");
    try {
      let report = await this.state.storage.get<PendingReport>(REPORT_KEY);
      if (!report) {
        const task = await this.state.storage.get<SubagentDispatch>(TASK_KEY);
        if (!task) {
          await this.cleanup();
          return;
        }
        const span = telemetry.tracer.startSpan("agent.subagent.task", {
          attributes: {
            "do.name": "ResearchSubagent",
            "agent.subagent.task_id": task.task_id,
            "agent.subagent.batch_id": task.batch_id,
            "agent.subagent.tier": task.tier,
            "gen_ai.request.model":
              task.tier === "foreground" ? CHAT_MODEL : BACKGROUND_MODEL,
          },
        });
        const startedAt = Date.now();
        if (Number.isFinite(task.enqueued_at)) {
          span.setAttribute(
            "agent.subagent.queue_wait_ms",
            Math.max(0, (task.dispatched_at ?? startedAt) - task.enqueued_at!),
          );
        }
        if (Number.isFinite(task.dispatched_at)) {
          span.setAttribute(
            "agent.subagent.alarm_wait_ms",
            Math.max(0, startedAt - task.dispatched_at!),
          );
        }
        let payload: Record<string, unknown>;
        const controller = new AbortController();
        this.activeController = controller;
        const deadlineTimer = setTimeout(
          () =>
            controller.abort(
              new DOMException(
                "Subagent task aborted at its deadline",
                "TimeoutError",
              ),
            ),
          Math.max(0, task.deadline_at - Date.now()),
        );
        try {
          if (await this.state.storage.get(CANCELLED_KEY))
            controller.abort(
              new DOMException("Subagent task cancelled", "AbortError"),
            );
          const result = await this.runTask(task, controller.signal, span);
          payload = {
            task_id: task.task_id,
            batch_id: task.batch_id,
            status: "done",
            result: result.text.slice(0, MAX_RESULT_CHARS),
            finish_reason:
              result.text.length > MAX_RESULT_CHARS
                ? "length"
                : result.finishReason,
            tokens_in: result.usage?.inputTokens ?? null,
            tokens_out: result.usage?.outputTokens ?? null,
          };
          span.setAttribute(
            "gen_ai.usage.input_tokens",
            result.usage?.inputTokens ?? 0,
          );
          span.setAttribute(
            "gen_ai.usage.output_tokens",
            result.usage?.outputTokens ?? 0,
          );
          span.setAttribute("agent.subagent.status", "done");
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          const cancelled =
            controller.signal.aborted &&
            controller.signal.reason?.name === "AbortError";
          const timeout =
            controller.signal.reason?.name === "TimeoutError" ||
            Date.now() >= task.deadline_at;
          const partial =
            error instanceof ToolLoopGenerationError
              ? error.partialResult
              : undefined;
          const filtered = partial?.finishReason === "content-filter";
          payload = {
            task_id: task.task_id,
            batch_id: task.batch_id,
            status: cancelled ? "cancelled" : "failed",
            // Provider error bodies can contain request data. Preserve their
            // cause locally while sending a bounded, safe generation error.
            error: filtered
              ? "The provider withheld this research answer because of content filtering."
              : (error instanceof Error
                  ? error.message
                  : "Subagent task failed"
                ).slice(0, 2_000),
            ...(partial
              ? {
                  result: partial.text.slice(0, MAX_RESULT_CHARS),
                  finish_reason: filtered ? "content-filter" : "error",
                  tokens_in: partial.usage?.inputTokens ?? null,
                  tokens_out: partial.usage?.outputTokens ?? null,
                }
              : {}),
          };
          span.setAttribute(
            "agent.subagent.failure_kind",
            cancelled
              ? "cancelled"
              : timeout
                ? "timeout"
                : partial
                  ? "provider"
                  : "setup",
          );
          span.setAttribute(
            "agent.subagent.status",
            cancelled ? "cancelled" : "failed",
          );
          if (partial?.usage) {
            span.setAttribute(
              "gen_ai.usage.input_tokens",
              partial.usage.inputTokens,
            );
            span.setAttribute(
              "gen_ai.usage.output_tokens",
              partial.usage.outputTokens,
            );
          }
          span.setStatus({
            code: cancelled ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          });
          if (!cancelled)
            logError("ResearchSubagent task failed", error as Error, {
              "do.name": "ResearchSubagent",
              "agent.subagent.task_id": task.task_id,
            });
        } finally {
          clearTimeout(deadlineTimer);
          if (this.activeController === controller)
            this.activeController = undefined;
          span.setAttribute(
            "agent.subagent.duration_ms",
            Date.now() - startedAt,
          );
          span.end();
        }
        // Cancellation can arrive while a late model success settles.
        if (await this.state.storage.get(CANCELLED_KEY))
          payload = {
            task_id: task.task_id,
            batch_id: task.batch_id,
            status: "cancelled",
            error: "Subagent task cancelled",
          };
        report = {
          task,
          payload,
          attempts: 0,
          created_at: Date.now(),
          expires_at: Date.now() + RETENTION_MS,
        };
        await this.state.storage.put(REPORT_KEY, report);
      }
      const deliverySpan = telemetry.tracer.startSpan(
        "agent.subagent.delivery",
        {
          attributes: {
            "agent.subagent.task_id": report.task.task_id,
            "agent.subagent.batch_id": report.task.batch_id,
          },
        },
      );
      try {
        await this.deliverReport(report, deliverySpan);
      } finally {
        deliverySpan.end();
      }
    } finally {
      await telemetry.forceFlush();
    }
  }

  private async deliverReport(
    report: PendingReport,
    span: Span,
  ): Promise<void> {
    if (
      report.reported ||
      report.attempts >= MAX_REPORT_ATTEMPTS ||
      report.expires_at <= Date.now()
    ) {
      if (!report.reported) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("agent.subagent.failure_kind", "report_expired");
        logWarn(
          "ResearchSubagent report expired; coordinator deadline settles missing results",
          {
            "agent.subagent.task_id": report.task.task_id,
            "agent.subagent.report_attempt": report.attempts,
          },
        );
      }
      await this.cleanup(report.task.task_id);
      return;
    }
    if (await this.state.storage.get(CANCELLED_KEY))
      report.payload = {
        task_id: report.task.task_id,
        batch_id: report.task.batch_id,
        status: "cancelled",
        error: "Subagent task cancelled",
      };
    report.attempts++;
    await this.state.storage.put(REPORT_KEY, report);
    // Establish recovery before the callback await. A crash after acceptance
    // resends this durable payload to the parent's idempotent settlement.
    const retryAt = Math.min(
      report.expires_at,
      Date.now() + Math.min(60_000, 1_000 * 2 ** (report.attempts - 1)),
    );
    await this.state.storage.setAlarm(retryAt);
    span.setAttribute("agent.subagent.report_attempt", report.attempts);
    span.setAttribute(
      "agent.subagent.delivery_latency_ms",
      Date.now() - report.created_at,
    );
    try {
      await this.reportToCoordinator(report.task, report.payload);
      report.reported = true;
      await this.state.storage.put(REPORT_KEY, report);
      await this.cleanup(report.task.task_id);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      logWarn("ResearchSubagent callback failed", {
        "do.name": "ResearchSubagent",
        "agent.subagent.task_id": report.task.task_id,
        "agent.subagent.report_attempt": report.attempts,
        "error.message": (error as Error).message,
        "agent.subagent.retry_scheduled": report.attempts < MAX_REPORT_ATTEMPTS,
      });
      if (report.attempts >= MAX_REPORT_ATTEMPTS)
        await this.cleanup(report.task.task_id);
    }
  }

  private async runTask(
    task: SubagentDispatch,
    signal: AbortSignal,
    span: Span,
  ) {
    const checkDeadline = () => {
      signal.throwIfAborted();
      if (Date.now() >= task.deadline_at)
        throw new Error("Subagent task deadline already passed");
    };
    checkDeadline();
    const { context: retrievalContext } = await withAbort(
      buildRetrievalContextFor({
        env: this.env,
        user_id: task.context.user_id,
        user_role: task.context.user_role,
        organization_id: task.context.organization_id,
        tenant_binding: task.context.tenant_binding,
      }),
      signal,
    );
    checkDeadline();
    if (!retrievalContext)
      throw new Error(
        `No retrieval context available for tenant binding "${task.context.tenant_binding}" — refusing to run a subagent with no tools`,
      );
    retrievalContext.filterMemoryIds = (ids) =>
      this.filterMemoryIds(task, ids, signal);
    const fullToolset = buildSubagentToolset({ retrievalContext });
    const requestedToolIds = new Set(task.toolset);
    const tools = Object.fromEntries(
      Object.entries(fullToolset).filter(([id]) => requestedToolIds.has(id)),
    ) as typeof fullToolset;
    if (Object.keys(tools).length === 0)
      throw new Error(
        `Subagent task ${task.task_id} has no usable tools after intersecting requested toolset [${task.toolset.join(", ")}] with the built catalogue`,
      );
    // Binding APIs may not accept cancellation. Check before starting every
    // retrieval and stop waiting when cancelled; no subsequent tool can start.
    for (const [id, tool] of Object.entries(tools)) {
      const execute = tool.execute;
      if (execute)
        tools[id] = {
          ...tool,
          execute: (input, options) => {
            checkDeadline();
            return withAbort(
              Promise.resolve(
                execute(input, { ...options, abortSignal: signal }),
              ),
              signal,
            );
          },
        };
    }
    checkDeadline();
    const modelStartedAt = Date.now();
    span.setAttribute("agent.subagent.model_started_at", modelStartedAt);
    try {
      const result = await withAbort(
        runToolLoop({
          env: this.env,
          model: task.tier === "foreground" ? CHAT_MODEL : BACKGROUND_MODEL,
          purpose: task.tier,
          system: buildSubagentSystemPrompt(task),
          messages: [{ role: "user", content: task.goal }],
          tools,
          maxSteps: SUBAGENT_MAX_STEPS,
          telemetryTag: "agent_subagent",
          abortSignal: signal,
        }),
        signal,
      );
      checkDeadline();
      // A filtered completion is not evidence that the requested research
      // found nothing. Retain any partial text while reporting it as failed.
      if (result.finishReason === "content-filter") {
        throw new ToolLoopGenerationError(
          new Error("Provider content filtering prevented completion"),
          result,
        );
      }
      return result;
    } finally {
      span.setAttribute("agent.subagent.model_ended_at", Date.now());
      span.setAttribute(
        "agent.subagent.model_duration_ms",
        Date.now() - modelStartedAt,
      );
    }
  }

  private async filterMemoryIds(
    task: SubagentDispatch,
    ids: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (ids.length === 0 || ids.length > 50 || signal?.aborted) return [];
    try {
      const stub = this.env.NANO_CHAT_AGENT.get(
        this.env.NANO_CHAT_AGENT.idFromName(task.coordinator_do_name),
      );
      const headers = await createInternalAuthHeaders(
        {
          userId: task.context.user_id,
          organizationId: task.context.organization_id,
          tenantBinding: task.context.tenant_binding,
          role: task.context.user_role,
        },
        this.env.INTERNAL_AUTH_SECRET,
      );
      const response = await stub.fetch(
        new Request("https://do/memory-filter", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
            : AbortSignal.timeout(5_000),
        }),
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { ids?: unknown };
      if (
        !Array.isArray(body?.ids) ||
        body.ids.some((id) => typeof id !== "string")
      )
        return [];
      const allowed = new Set(body.ids);
      return ids.filter((id) => allowed.has(id));
    } catch {
      // A transient coordinator failure must never widen memory visibility.
      return [];
    }
  }

  private async reportToCoordinator(
    task: SubagentDispatch,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const id = this.env.NANO_CHAT_AGENT.idFromName(task.coordinator_do_name);
    const stub = this.env.NANO_CHAT_AGENT.get(id);
    // the coordinator's /subagent-result requires the internal-auth
    // envelope — sign the callback with this task's owning principal.
    const headers = await createInternalAuthHeaders(
      {
        userId: task.context.user_id,
        organizationId: task.context.organization_id,
        tenantBinding: task.context.tenant_binding,
        role: task.context.user_role,
      },
      this.env.INTERNAL_AUTH_SECRET,
    );
    const signal = AbortSignal.timeout(CALLBACK_TIMEOUT_MS);
    const res = await withAbort(
      stub.fetch(
        new Request("https://do/subagent-result", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal,
        }),
      ),
      signal,
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      // Unknown/retired parent tasks are terminal. Retry other non-success
      // statuses with a fresh stub on the next alarm.
      throw new Error(
        `Coordinator callback rejected with status ${res.status}`,
      );
    }
  }
}

/**
 * A subagent answers one question and returns prose. It has no user to talk
 * to, so the prompt tells it to report findings rather than converse, and
 * states plainly that it cannot write — the toolset already enforces that,
 * but a model that knows its limits wastes fewer steps discovering them.
 */
function buildSubagentSystemPrompt(task: SubagentDispatch): string {
  return [
    `You are a research subagent working for ${task.context.user_name}, a ${task.context.user_role} in their workspace.`,
    "",
    "You have ONE objective, stated in the user message. Investigate it using your tools and report what you found.",
    "",
    "Rules:",
    "- You are READ-ONLY. You cannot create, update, delete, or send anything, and you must not claim to have done so.",
    "- You cannot delegate. Do the work yourself within your step budget.",
    "- Report findings as plain prose. No preamble, no offers of further help — nobody is reading this conversationally.",
    "- If you find nothing, say so plainly. An empty result is a valid answer.",
    "- Cite the specific records you relied on by name and id.",
  ].join("\n");
}
