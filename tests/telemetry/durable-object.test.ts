import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { createDurableObjectTelemetry } from "../../src/telemetry/durable-object";

afterEach(() => vi.restoreAllMocks());

describe("invocation-scoped Durable Object telemetry", () => {
  it("exports completed cold alarm spans through a real SDK without global initialization", async () => {
    const exporter = new InMemorySpanExporter();
    const globalProvider = trace.getTracerProvider();
    const telemetry = createDurableObjectTelemetry(
      { OTLP_ENDPOINT: "https://collector.test" },
      "agent.subagent",
      { exporter },
    );
    const span = telemetry.tracer.startSpan("agent.subagent.run");
    span.setAttributes({
      "subagent.queue_wait_ms": 250,
      "subagent.model_duration_ms": 400,
      "subagent.status": "done",
      "gen_ai.usage.input_tokens": 20,
    });
    await Promise.resolve();
    span.end();
    await telemetry.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("agent.subagent.run");
    expect(spans[0].attributes["subagent.queue_wait_ms"]).toBe(250);
    expect(spans[0].instrumentationScope.name).toBe("agent.subagent");
    expect(trace.getTracerProvider()).toBe(globalProvider);
  });

  it("keeps invocation resources separate even when endpoints/credentials change", async () => {
    const first = new InMemorySpanExporter();
    const second = new InMemorySpanExporter();
    const a = createDurableObjectTelemetry(
      {
        OTLP_ENDPOINT: "https://first.test",
        OTLP_HEADERS: '{"Authorization":"first"}',
      },
      "agent.coordinator",
      { exporter: first },
    );
    const b = createDurableObjectTelemetry(
      {
        OTLP_ENDPOINT: "https://second.test",
        OTLP_HEADERS: '{"Authorization":"second"}',
      },
      "agent.subagent",
      { exporter: second },
    );
    a.tracer.startSpan("first").end();
    b.tracer.startSpan("second").end();
    await a.forceFlush();
    expect(first.getFinishedSpans().map((span) => span.name)).toEqual([
      "first",
    ]);
    expect(second.getFinishedSpans()).toEqual([]);
    await b.forceFlush();
    expect(second.getFinishedSpans().map((span) => span.name)).toEqual([
      "second",
    ]);
  });

  it("creates no timer until explicit bounded flush, and clears it afterwards", async () => {
    vi.useFakeTimers();
    try {
      const exporter = new InMemorySpanExporter();
      const telemetry = createDurableObjectTelemetry(
        { OTLP_ENDPOINT: "https://collector.test" },
        "agent.subagent",
        { exporter },
      );
      telemetry.tracer.startSpan("alarm").end();
      expect(vi.getTimerCount()).toBe(0);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      const flush = telemetry.forceFlush();
      await vi.advanceTimersByTimeAsync(0);
      await flush;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stuck exporter and settles flush failures without affecting the alarm", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const exporter: SpanExporter = {
        export: () => {},
        shutdown: async () => {},
      };
      const telemetry = createDurableObjectTelemetry(
        { OTLP_ENDPOINT: "https://collector.test" },
        "agent.subagent",
        { exporter, exportTimeoutMs: 50 },
      );
      telemetry.tracer.startSpan("alarm").end();
      const done = vi.fn();
      const flush = telemetry.forceFlush().then(done);
      await vi.advanceTimersByTimeAsync(49);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flush;
      expect(done).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains failed spans at a zero normal sample rate and never exports them twice", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createDurableObjectTelemetry(
      { OTLP_ENDPOINT: "https://collector.test", OTEL_TRACE_SAMPLE_RATE: "0" },
      "agent.subagent",
      { exporter },
    );
    telemetry.tracer.startSpan("normal").end();
    const failed = telemetry.tracer.startSpan("failed");
    failed.setStatus({ code: SpanStatusCode.ERROR });
    failed.end();
    await Promise.all([telemetry.forceFlush(), telemetry.forceFlush()]);
    await telemetry.forceFlush();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "failed",
    ]);
  });

  it("uses a private noop provider with no configured endpoint even when globals exist", async () => {
    const telemetry = createDurableObjectTelemetry({}, "agent.subagent");
    expect(telemetry.isEnabled).toBe(false);
    expect(telemetry.tracer.startSpan("disabled").isRecording()).toBe(false);
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
  });
});
