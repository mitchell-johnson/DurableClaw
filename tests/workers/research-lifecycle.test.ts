import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { ResearchSubagent } from "../../src/durable-objects/ResearchSubagent";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";

// Recreate the child against native storage to exercise recovery independently
// of the provider. This does not simulate an actual platform eviction event.
function storageHost() {
  return (env as any).RESEARCH_SUBAGENT.get(
    (env as any).RESEARCH_SUBAGENT.idFromName(
      `child-lifecycle-${crypto.randomUUID()}`,
    ),
  );
}
function dispatch() {
  return {
    task_id: "child-1",
    batch_id: "batch-1",
    goal: "Research",
    tier: "background" as const,
    toolset: ["search_records"],
    deadline_at: Date.now() + 60_000,
    coordinator_do_name: "owner:workspace",
    context: {
      user_id: "owner",
      user_name: "Owner",
      user_role: "admin",
      organization_id: "org",
      tenant_binding: "workspace",
    },
  };
}

describe("ResearchSubagent lifecycle against real workerd storage", () => {
  it("recreates from report_pending after a transient callback failure without generating again", async () => {
    const result = await runInDurableObject(
      storageHost(),
      async (_instance: any, state: DurableObjectState) => {
        const task = dispatch();
        let generationCalls = 0;
        const reports: any[] = [];
        const runtimeEnv = {
          ...env,
          INTERNAL_AUTH_SECRET: "test-secret",
          NANO_CHAT_AGENT: {
            idFromName: () => "parent",
            get: () => ({
              fetch: async (request: Request) => {
                reports.push(await request.json());
                return new Response("{}", {
                  status: reports.length === 1 ? 503 : 200,
                });
              },
            }),
          },
        } as any;
        await state.storage.put("task", task);
        await state.storage.put("report_pending", {
          task,
          payload: {
            task_id: task.task_id,
            batch_id: task.batch_id,
            status: "done",
            result: "Persisted answer",
          },
          attempts: 0,
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
        });
        const first = new ResearchSubagent(state, runtimeEnv);
        (first as any).runTask = () => {
          generationCalls++;
          throw new Error("Generation must not repeat");
        };
        await first.alarm();
        const pending = await state.storage.get<any>("report_pending");
        const retryAlarm = await state.storage.getAlarm();
        const restarted = new ResearchSubagent(state, runtimeEnv);
        (restarted as any).runTask = () => {
          generationCalls++;
          throw new Error("Generation must not repeat");
        };
        await restarted.alarm();
        const remainingKeys = [...(await state.storage.list()).keys()];
        await state.storage.deleteAlarm();
        return {
          generationCalls,
          reports,
          attempts: pending?.attempts,
          retryAlarm,
          remainingKeys,
        };
      },
    );
    expect(result.generationCalls).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.retryAlarm).toBeTypeOf("number");
    expect(result.reports).toHaveLength(2);
    expect(result.reports[0]).toEqual(result.reports[1]);
    expect(result.reports[1]).toMatchObject({
      status: "done",
      result: "Persisted answer",
    });
    expect(result.remainingKeys).toEqual([]);
  });

  it("retains cancel-before-dispatch through reconstruction and cleans the tombstone at expiry", async () => {
    const result = await runInDurableObject(
      storageHost(),
      async (_instance: any, state: DurableObjectState) => {
        const task = dispatch();
        const runtimeEnv = {
          ...env,
          INTERNAL_AUTH_SECRET: "test-secret",
        } as any;
        const headers = await createInternalAuthHeaders(
          {
            userId: "owner",
            organizationId: "org",
            tenantBinding: "workspace",
            role: "admin",
          },
          "test-secret",
        );
        const first = new ResearchSubagent(state, runtimeEnv);
        await first.fetch(
          new Request("https://do/cancel", {
            method: "POST",
            headers,
            body: JSON.stringify({ task_id: task.task_id }),
          }),
        );
        await first.alarm();
        const restarted = new ResearchSubagent(state, runtimeEnv);
        const response = await restarted.fetch(
          new Request("https://do/dispatch", {
            method: "POST",
            headers,
            body: JSON.stringify(task),
          }),
        );
        const body = await response.json();
        const tombstone = await state.storage.get<any>("cancelled");
        const scheduled = await state.storage.getAlarm();
        await state.storage.put("cancelled", {
          ...tombstone,
          expires_at: Date.now() - 1,
        });
        await restarted.alarm();
        const remainingKeys = [...(await state.storage.list()).keys()];
        await state.storage.deleteAlarm();
        return {
          body,
          expiresAt: tombstone.expires_at,
          scheduled,
          remainingKeys,
        };
      },
    );
    expect(result.body).toMatchObject({ cancelled: true });
    expect(result.scheduled).toBe(result.expiresAt);
    expect(result.remainingKeys).toEqual([]);
  });
});
