import type { AgentPrincipal, Env } from "../../types";
import { MessagingActivityError } from "../../channels/plugin";
import { messagingRegistry, sendLinkedTyping } from "../../channels/service";
import { cancelJobs, scheduleJob, type ScheduledJob } from "./scheduler";
import type { SqlExecLike } from "./memory";

export const TYPING_INTERVAL_MS = 4000;
const jobId = (requestId: string) => `channel_typing_${requestId}`;
type Activity = { conversationId: string; requestId: string };

/** Activity is derived from real coordinator work, never from the lifetime of
 * a webhook. Alarms survive hibernation while a subagent batch is outstanding. */
export class ChannelActivity {
  private inflight = new Map<string, AbortController>();

  constructor(
    private readonly host: {
      env: Env;
      sql: SqlExecLike;
      hasWork: (conversationId: string, requestId: string) => boolean;
      principal: () => Promise<AgentPrincipal>;
      rearm: () => Promise<void>;
      waitUntil: (work: Promise<void>) => void;
    },
  ) {}

  start(conversationId: string, requestId: string): void {
    if (
      !this.host.env.CONTROL_DB ||
      !messagingRegistry
        .list()
        .some((plugin) => plugin.sendTyping && plugin.configured(this.host.env))
    )
      return;
    // A typing failure must never reject the actual conversation request.
    this.host.waitUntil(
      this.tick({ conversationId, requestId }).catch(() => {}),
    );
  }

  stopIfIdle(conversationId: string, requestId: string): void {
    if (this.host.hasWork(conversationId, requestId)) return;
    cancelJobs(this.host.sql, { job_id: jobId(requestId) });
    this.inflight.get(requestId)?.abort();
  }

  async run(job: ScheduledJob): Promise<void> {
    const activity = JSON.parse(job.payload_json || "{}") as Activity;
    if (
      typeof activity.conversationId !== "string" ||
      typeof activity.requestId !== "string"
    )
      return;
    await this.tick(activity);
  }

  private schedule(activity: Activity, delay: number): void {
    scheduleJob(this.host.sql, {
      job_id: jobId(activity.requestId),
      kind: "channel_typing",
      payload: activity,
      run_at: Date.now() + delay,
      now: Date.now(),
    });
  }

  private async tick(activity: Activity): Promise<void> {
    const { conversationId, requestId } = activity;
    if (!this.host.hasWork(conversationId, requestId)) {
      this.stopIfIdle(conversationId, requestId);
      return;
    }
    this.schedule(activity, TYPING_INTERVAL_MS);
    // A slow provider cannot create overlapping chat actions for a request.
    if (this.inflight.has(requestId)) return;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    try {
      // Persist the next wake before any provider request.
      await this.host.rearm();
      const principal = await this.host.principal();
      this.stopIfIdle(conversationId, requestId);
      if (controller.signal.aborted) return;
      if (
        principal.role !== "owner" ||
        !(await sendLinkedTyping(
          this.host.env,
          principal,
          conversationId,
          requestId,
          controller.signal,
        ))
      )
        cancelJobs(this.host.sql, { job_id: jobId(requestId) });
    } catch (error) {
      if (
        !controller.signal.aborted &&
        this.host.hasWork(conversationId, requestId)
      ) {
        if (
          error instanceof MessagingActivityError &&
          [400, 401, 403, 404].includes(error.status)
        )
          cancelJobs(this.host.sql, { job_id: jobId(requestId) });
        else
          this.schedule(
            activity,
            error instanceof MessagingActivityError
              ? error.retryAfterMs
              : 30_000,
          );
      }
      // Only sanitized errors cross the adapter boundary; activity is optional.
    } finally {
      this.inflight.delete(requestId);
      this.stopIfIdle(conversationId, requestId);
      await this.host.rearm();
    }
  }
}
