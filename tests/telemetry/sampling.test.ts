/**
 * Tests for the tail-based trace sampler (telemetry/sampling.ts).
 *
 * Uses the real @opentelemetry/api SpanStatusCode and a mock inner
 * SpanProcessor so we observe exactly which spans get forwarded.
 */

import { describe, it, expect, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  TailSamplingSpanProcessor,
  traceIdToUnitInterval,
} from "../../src/telemetry/sampling";

/** A mock SpanProcessor that records what it's asked to do. */
function makeInner() {
  return {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a minimal ReadableSpan-like object for the processor's onEnd path. */
function makeSpan(opts: {
  traceId?: string;
  durationMs?: number;
  status?: SpanStatusCode;
  events?: Array<{ name: string }>;
}): any {
  const durationMs = opts.durationMs ?? 1;
  const seconds = Math.trunc(durationMs / 1000);
  const nanos = Math.round((durationMs - seconds * 1000) * 1e6);
  return {
    spanContext: () => ({
      traceId: opts.traceId ?? "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    }),
    duration: [seconds, nanos],
    status: { code: opts.status ?? SpanStatusCode.UNSET },
    events: opts.events ?? [],
  };
}

describe("traceIdToUnitInterval", () => {
  it("is deterministic for the same trace id", () => {
    const id = "1234567890abcdef1234567890abcdef";
    expect(traceIdToUnitInterval(id)).toBe(traceIdToUnitInterval(id));
  });

  it("returns a value in [0, 1)", () => {
    for (const id of [
      "0".repeat(32),
      "f".repeat(32),
      "deadbeefdeadbeefdeadbeefdeadbeef",
    ]) {
      const v = traceIdToUnitInterval(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("produces different values for different trace ids", () => {
    expect(traceIdToUnitInterval("a".repeat(32))).not.toBe(
      traceIdToUnitInterval("b".repeat(32)),
    );
  });
});

describe("TailSamplingSpanProcessor", () => {
  describe("sampleRate = 1.0 (keep everything)", () => {
    it("forwards a healthy, fast span", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 1.0,
        slowMs: 1000,
      });

      proc.onEnd(makeSpan({ durationMs: 1 }));

      expect(inner.onEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("sampleRate = 0.0 (drop unremarkable, keep errors + slow)", () => {
    it("drops a healthy, fast span", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 0.0,
        slowMs: 1000,
      });

      proc.onEnd(makeSpan({ durationMs: 1 }));

      expect(inner.onEnd).not.toHaveBeenCalled();
    });

    it("KEEPS a span whose status is ERROR", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 0.0,
        slowMs: 1000,
      });

      proc.onEnd(makeSpan({ durationMs: 1, status: SpanStatusCode.ERROR }));

      expect(inner.onEnd).toHaveBeenCalledTimes(1);
    });

    it("KEEPS a span that recorded an exception event", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 0.0,
        slowMs: 1000,
      });

      proc.onEnd(makeSpan({ durationMs: 1, events: [{ name: "exception" }] }));

      expect(inner.onEnd).toHaveBeenCalledTimes(1);
    });

    it("KEEPS a span at or above the slow threshold", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 0.0,
        slowMs: 1000,
      });

      proc.onEnd(makeSpan({ durationMs: 1000 }));

      expect(inner.onEnd).toHaveBeenCalledTimes(1);
    });

    it("drops a span just under the slow threshold", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 0.0,
        slowMs: 1000,
      });

      proc.onEnd(makeSpan({ durationMs: 999 }));

      expect(inner.onEnd).not.toHaveBeenCalled();
    });
  });

  describe("trace-coherence (determinism by trace id)", () => {
    it("makes the same keep/drop decision for every span sharing a trace id", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 0.5,
        slowMs: 1000,
      });

      const traceId = "1234567890abcdef1234567890abcdef";
      const expectKept = traceIdToUnitInterval(traceId) < 0.5;

      // Three healthy, fast spans sharing the trace id.
      proc.onEnd(makeSpan({ traceId, durationMs: 1 }));
      proc.onEnd(makeSpan({ traceId, durationMs: 2 }));
      proc.onEnd(makeSpan({ traceId, durationMs: 3 }));

      // Either all three are forwarded or none are — never a partial split.
      expect(inner.onEnd).toHaveBeenCalledTimes(expectKept ? 3 : 0);
    });
  });

  describe("lifecycle delegation", () => {
    it("delegates onStart to the wrapped processor", () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 1.0,
        slowMs: 1000,
      });

      const span = {} as any;
      const ctx = {} as any;
      proc.onStart(span, ctx);

      expect(inner.onStart).toHaveBeenCalledWith(span, ctx);
    });

    it("delegates forceFlush to the wrapped processor", async () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 1.0,
        slowMs: 1000,
      });

      await proc.forceFlush();

      expect(inner.forceFlush).toHaveBeenCalledTimes(1);
    });

    it("delegates shutdown to the wrapped processor", async () => {
      const inner = makeInner();
      const proc = new TailSamplingSpanProcessor(inner as any, {
        sampleRate: 1.0,
        slowMs: 1000,
      });

      await proc.shutdown();

      expect(inner.shutdown).toHaveBeenCalledTimes(1);
    });
  });
});
