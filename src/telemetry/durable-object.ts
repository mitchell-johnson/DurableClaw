/**
 * Invocation-owned tracing for Durable Objects, including cold alarms.
 *
 * Do not use the Worker singleton here: another invocation may own its pending
 * network I/O, and its metric reader keeps a periodic timer alive. This helper
 * installs no globals and buffers only this invocation's spans until the caller
 * ends them and awaits forceFlush() (or passes it to state.waitUntil()). Never
 * retain the returned object on the Durable Object between invocations.
 *
 * Timing, token usage/cost units and bounded outcome enums belong on these spans;
 * no periodic metric reader or high-cardinality metric labels are needed.
 */
import { ProxyTracerProvider, type Context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ExportResultCode } from "@opentelemetry/core";
import { TailSamplingSpanProcessor } from "./sampling";

interface DurableObjectTelemetryEnv {
  OTLP_ENDPOINT?: string;
  OTLP_HEADERS?: string;
  ENVIRONMENT?: string;
  OTEL_TRACE_SAMPLE_RATE?: string;
  OTEL_TRACE_SLOW_MS?: string;
}

interface DurableObjectTelemetryOptions {
  /** Override the transport, e.g. an in-memory exporter for cold-alarm tests. */
  exporter?: SpanExporter;
  exportTimeoutMs?: number;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 1_500;
const MAX_PENDING_SPANS = 256;

/** No timer or I/O starts until this invocation explicitly finishes. */
class InvocationSpanProcessor implements SpanProcessor {
  private spans: ReadableSpan[] = [];
  private flushing?: Promise<void>;

  constructor(
    private readonly exporter: SpanExporter,
    private readonly timeoutMs: number,
  ) {}

  onStart(_span: Span, _context: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (!this.flushing && this.spans.length < MAX_PENDING_SPANS)
      this.spans.push(span);
  }

  forceFlush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const spans = this.spans;
    this.spans = [];
    // Keep all completion work invocation-owned and bounded, even when an
    // exporter misbehaves. OTLP's own timeout aborts its transport as well.
    this.flushing = new Promise<void>((resolve) => {
      let complete = false;
      const timer = setTimeout(
        () => finish(new Error("Durable Object trace export timed out")),
        this.timeoutMs,
      );
      const finish = (error?: unknown) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        if (error) console.warn("[OTel] Durable Object trace export failed");
        resolve();
      };
      if (!spans.length) {
        finish();
        return;
      }
      try {
        this.exporter.export(spans, (result) =>
          finish(
            result.code === ExportResultCode.SUCCESS
              ? undefined
              : (result.error ?? new Error("Trace export failed")),
          ),
        );
      } catch (error) {
        finish(error);
      }
    });
    return this.flushing;
  }

  shutdown(): Promise<void> {
    return this.forceFlush();
  }
}

/** Create once per alarm/fetch invocation; forceFlush is idempotent and terminal. */
export function createDurableObjectTelemetry(
  env: DurableObjectTelemetryEnv,
  scope: string,
  options: DurableObjectTelemetryOptions = {},
) {
  if (!env.OTLP_ENDPOINT) {
    return {
      tracer: new ProxyTracerProvider().getTracer(scope),
      isEnabled: false,
      forceFlush: async () => {},
    };
  }

  const timeoutMs =
    options.exportTimeoutMs !== undefined &&
    Number.isFinite(options.exportTimeoutMs)
      ? Math.min(5_000, Math.max(1, options.exportTimeoutMs))
      : DEFAULT_EXPORT_TIMEOUT_MS;
  let headers: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(env.OTLP_HEADERS ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      headers = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
  } catch {
    console.warn("[OTel] Invalid Durable Object trace headers");
  }

  const exporter =
    options.exporter ??
    new OTLPTraceExporter({
      url: `${env.OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`,
      headers,
      timeoutMillis: timeoutMs,
    });
  const processor = new InvocationSpanProcessor(exporter, timeoutMs);
  const sampleRate = Number.parseFloat(env.OTEL_TRACE_SAMPLE_RATE ?? "1");
  const slowMs = Number.parseFloat(env.OTEL_TRACE_SLOW_MS ?? "1000");
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "durableclaw",
      "service.version": "0.1.0",
      "deployment.environment.name": env.ENVIRONMENT ?? "production",
      "cloud.provider": "cloudflare",
      "cloud.platform": "cloudflare_durable_objects",
    }),
    spanProcessors: [
      new TailSamplingSpanProcessor(processor, {
        sampleRate: Number.isFinite(sampleRate)
          ? Math.min(1, Math.max(0, sampleRate))
          : 1,
        slowMs: Number.isFinite(slowMs) && slowMs >= 0 ? slowMs : 1000,
      }),
    ],
  });
  return {
    tracer: provider.getTracer(scope, "0.1.0"),
    isEnabled: true,
    forceFlush: () => processor.forceFlush(),
  };
}
