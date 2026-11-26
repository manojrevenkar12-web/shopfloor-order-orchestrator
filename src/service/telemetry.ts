import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

/** Spans go to whatever OpenTelemetry SDK the process registers (OTLP in deployment, in-memory in tests). */
export const tracer = trace.getTracer("shopfloor-order-orchestrator", "0.1.0");

export function traced<T>(name: string, attrs: Record<string, string | number>, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, { attributes: attrs }, (span) => {
    try {
      const r = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

export function metrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    ordersReceived: new Counter({ name: "orchestrator_orders_received_total", help: "Orders accepted at intake", labelNames: ["source", "duplicate"], registers: [registry] }),
    orderStates: new Counter({ name: "orchestrator_order_transitions_total", help: "Order lifecycle transitions", labelNames: ["state"], registers: [registry] }),
    dispatches: new Counter({ name: "orchestrator_dispatches_total", help: "Tasks dispatched to resources", labelNames: ["resource", "form_factor"], registers: [registry] }),
    taskEvents: new Counter({ name: "orchestrator_task_events_total", help: "Edge task events applied", labelNames: ["edge", "kind"], registers: [registry] }),
    edgeOnline: new Gauge({ name: "orchestrator_edge_online", help: "1 if the edge was heard from recently", labelNames: ["edge"], registers: [registry] }),
    activeTasks: new Gauge({ name: "orchestrator_active_tasks", help: "Tasks not yet done", registers: [registry] }),
    pendingConfirmations: new Gauge({ name: "orchestrator_erp_confirmations_pending", help: "Finished orders not yet booked by the ERP", registers: [registry] }),
    duplicatesIgnored: new Gauge({ name: "orchestrator_duplicate_events_ignored", help: "Edge events dropped as duplicates (cumulative)", registers: [registry] }),
  };
}

export type Metrics = ReturnType<typeof metrics>;
