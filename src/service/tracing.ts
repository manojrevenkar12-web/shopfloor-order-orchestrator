import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

/** Exports spans over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise spans are no-ops. */
export function startTracing(env: NodeJS.ProcessEnv = process.env): (() => Promise<void>) | undefined {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME ?? "shopfloor-order-orchestrator" }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  });
  trace.setGlobalTracerProvider(provider);
  return () => provider.shutdown();
}
