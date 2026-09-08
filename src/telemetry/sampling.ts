/** Invocation-local sampling retains errors and slow traces alongside a configurable sample. */

import { SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface TailSamplingOptions {
  /** Fraction of otherwise-unremarkable traces to keep, in [0, 1]. */
  sampleRate: number;
  /** Spans at least this many milliseconds long are always kept. */
  slowMs: number;
}

/**
 * Map a trace id to a stable value in [0, 1) using a 32-bit FNV-1a hash.
 *
 * Deterministic and trace-coherent: every span sharing a trace id maps to the
 * same value, so the ratio keep/drop decision is identical across the trace.
 */
export function traceIdToUnitInterval(traceId: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < traceId.length; i++) {
    hash ^= traceId.charCodeAt(i);
    // FNV prime multiply, kept in the unsigned 32-bit range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Normalise to [0, 1). Max value is (2^32 - 1) / 2^32 < 1, so a sampleRate of
  // 1.0 keeps every span and a sampleRate of 0.0 keeps none (by ratio).
  return hash / 0x1_0000_0000;
}

/** Span duration in milliseconds from its HrTime [seconds, nanoseconds] tuple. */
function spanDurationMs(span: ReadableSpan): number {
  const [seconds, nanos] = span.duration;
  return seconds * 1000 + nanos / 1e6;
}

/** A span counts as an error if its status is ERROR or it recorded an exception. */
function isError(span: ReadableSpan): boolean {
  if (span.status.code === SpanStatusCode.ERROR) return true;
  // recordException() appends an event named 'exception'; keep those traces even
  // when the span status was never explicitly set to ERROR.
  return span.events.some((event) => event.name === "exception");
}

/**
 * SpanProcessor wrapper that tail-samples on span end.
 *
 * Composes around a real processor (e.g. SimpleSpanProcessor): forwards a span
 * to the wrapped processor only when it should be kept, and drops it otherwise.
 * forceFlush / shutdown delegate straight through so the SDK lifecycle is
 * unaffected.
 */
export class TailSamplingSpanProcessor implements SpanProcessor {
  private readonly inner: SpanProcessor;
  private readonly sampleRate: number;
  private readonly slowMs: number;

  constructor(inner: SpanProcessor, options: TailSamplingOptions) {
    this.inner = inner;
    this.sampleRate = options.sampleRate;
    this.slowMs = options.slowMs;
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (this.shouldKeep(span)) {
      this.inner.onEnd(span);
    }
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  /**
   * Keep a span when ANY of:
   *   1. it errored (status ERROR or a recorded exception), or
   *   2. it ran at least slowMs, or
   *   3. its trace id falls under sampleRate (deterministic, trace-coherent).
   */
  private shouldKeep(span: ReadableSpan): boolean {
    if (isError(span)) return true;
    if (spanDurationMs(span) >= this.slowMs) return true;
    return traceIdToUnitInterval(span.spanContext().traceId) < this.sampleRate;
  }
}
