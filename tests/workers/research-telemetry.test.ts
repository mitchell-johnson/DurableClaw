import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { ResearchSubagent } from "../../src/durable-objects/ResearchSubagent";
import { createDurableObjectTelemetry } from "../../src/telemetry/durable-object";

// This uses a fresh DO's invocation context and the real production OTLP
// exporter, not the globally initialized Worker instrumentation.
afterEach(() => vi.restoreAllMocks());
describe("cold Durable Object trace export in workerd", () => {
  it("delivers a completed span to an OTLP collector from an isolated invocation", async () => {
    let exported: any;
    const collect = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(String(input)).toBe("https://otel-do.test/v1/traces");
        const body = init?.body;
        exported = JSON.parse(
          typeof body === "string"
            ? body
            : new TextDecoder().decode(body as Uint8Array),
        );
        return new Response("{}");
      });
    const stub = (env as any).RESEARCH_SUBAGENT.get(
      (env as any).RESEARCH_SUBAGENT.idFromName("cold-telemetry-transport"),
    );
    await runInDurableObject(stub, async () => {
      const telemetry = createDurableObjectTelemetry(
        { OTLP_ENDPOINT: "https://otel-do.test" },
        "agent.subagent",
      );
      telemetry.tracer.startSpan("agent.subagent.cold_alarm").end();
      await telemetry.forceFlush();
    });
    expect(exported?.resourceSpans[0].scopeSpans[0].spans[0].name).toBe(
      "agent.subagent.cold_alarm",
    );
    expect(collect).toHaveBeenCalledOnce();
  });

  it("exports terminal task and callback spans from an actual cold child alarm", async () => {
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let exported: any;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = init?.body;
      exported = JSON.parse(
        typeof body === "string"
          ? body
          : new TextDecoder().decode(body as Uint8Array),
      );
      return new Response("{}");
    });
    const stub = (env as any).RESEARCH_SUBAGENT.get(
      (env as any).RESEARCH_SUBAGENT.idFromName("cold-child-alarm-telemetry"),
    );
    await runInDurableObject(
      stub,
      async (_instance: unknown, state: DurableObjectState) => {
        const now = Date.now();
        await state.storage.put("task", {
          task_id: "cold-task",
          batch_id: "cold-batch",
          goal: "Expired research",
          tier: "background",
          toolset: ["search_records"],
          deadline_at: now - 1,
          enqueued_at: now - 300,
          dispatched_at: now - 200,
          coordinator_do_name: "owner:workspace",
          context: {
            user_id: "owner",
            user_name: "Owner",
            user_role: "admin",
            organization_id: "org",
            tenant_binding: "workspace",
          },
        });
        const child = new ResearchSubagent(state, {
          ...env,
          OTLP_ENDPOINT: "https://otel-do.test",
          OTEL_TRACE_SAMPLE_RATE: "1",
          INTERNAL_AUTH_SECRET: "telemetry-test",
          NANO_CHAT_AGENT: {
            idFromName: () => "parent",
            get: () => ({ fetch: async () => new Response("{}") }),
          },
        } as any);
        await child.alarm();
        await state.storage.deleteAlarm();
      },
    );
    const spans = exported?.resourceSpans.flatMap((resource: any) =>
      resource.scopeSpans.flatMap((scope: any) => scope.spans),
    );
    expect(spans.map((span: any) => span.name)).toEqual([
      "agent.subagent.task",
      "agent.subagent.delivery",
    ]);
    const attributes = Object.fromEntries(
      spans[0].attributes.map((attribute: any) => [
        attribute.key,
        attribute.value,
      ]),
    );
    expect(attributes["agent.subagent.queue_wait_ms"]).toEqual({
      intValue: 100,
    });
    expect(attributes["agent.subagent.failure_kind"]).toEqual({
      stringValue: "timeout",
    });
    expect(spans[0].endTimeUnixNano).toBeDefined();
    expect(failureLog).toHaveBeenCalledOnce();
  });
});
