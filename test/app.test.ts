import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/lab/designs.js";
import { buildApp } from "../src/service/app.js";
import { DEFAULT_BINS, parseTokens } from "../src/service/config.js";
import { metrics } from "../src/service/telemetry.js";
import { rig, T0 } from "./helpers.js";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
});
afterAll(() => trace.disable());

function app() {
  const r = rig(design("orchestrator").cloud, design("orchestrator").edge);
  const a = buildApp({ orchestrator: r.cloud, resources: r.resources, bins: DEFAULT_BINS, tokens: parseTokens("erp:e1,viewer:v1,supervisor:s1"), metrics: metrics(), clock: () => r.engine.now });
  return { r, a };
}

const ewm = { EWMWarehouse: "1710", WarehouseTask: "100000812", Product: "HU-1", SourceStorageBin: "SM-01-03-B", DestinationStorageBin: "GI-ZONE-2", TargetQuantityInBaseUnit: 1, NetWeight: 90 };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("HTTP API", () => {
  it("guards every route by role", async () => {
    const { a } = app();
    expect((await a.inject({ method: "GET", url: "/v1/orders" })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/v1/intake/ewm", headers: auth("v1"), payload: ewm })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/v1/orders", headers: auth("e1") })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/v1/orders", headers: auth("s1") })).statusCode).toBe(200);
  });

  it("accepts an EWM task once, and says so when it comes again", async () => {
    const { a, r } = app();
    const first = await a.inject({ method: "POST", url: "/v1/intake/ewm", headers: auth("e1"), payload: ewm });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ orderId: "EWM-1710-100000812-0001", duplicate: false, tasks: ["EWM-1710-100000812-0001/1"] });
    expect((await a.inject({ method: "POST", url: "/v1/intake/ewm", headers: auth("e1"), payload: ewm })).json()).toMatchObject({ duplicate: true });
    expect(r.cloud.orders.size).toBe(1);
    expect(exporter.getFinishedSpans().some((s) => s.name === "intake" && s.attributes["order.id"] === "EWM-1710-100000812-0001")).toBe(true);
  });

  it("rejects bad payloads with the reason", async () => {
    const { a } = app();
    const bad = await a.inject({ method: "POST", url: "/v1/intake/ewm", headers: auth("e1"), payload: { ...ewm, DestinationStorageBin: "X" } });
    expect(bad.statusCode).toBe(422);
    const invalid = await a.inject({ method: "POST", url: "/v1/intake/mes", headers: auth("e1"), payload: { ID: "1" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().issues.length).toBeGreaterThan(0);
  });

  it("serves orders, resources, an explanation and Prometheus metrics", async () => {
    const { a, r } = app();
    await a.inject({ method: "POST", url: "/v1/intake/ewm", headers: auth("e1"), payload: ewm });
    r.until(30 * 60_000);
    const o = (await a.inject({ method: "GET", url: "/v1/orders/EWM-1710-100000812-0001", headers: auth("v1") })).json();
    expect(o.state).toBe("CONFIRMED");
    const res = (await a.inject({ method: "GET", url: "/v1/resources", headers: auth("v1") })).json();
    expect(res).toHaveLength(11);
    const ex = (await a.inject({ method: "GET", url: "/v1/orders/EWM-1710-100000812-0001/explanation", headers: auth("v1") })).json();
    expect(ex.explanation.source).toBe("template");
    const m = await a.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toContain('orchestrator_orders_received_total{source="EWM",duplicate="false"} 1');
    expect(m.body).toContain('orchestrator_edge_online{edge="fleet-vda5050"} 1');
    expect(exporter.getFinishedSpans().some((s) => s.name === "dispatch" && s.attributes["edge.id"] === "fleet-vda5050")).toBe(true);
    void T0;
  });
});
