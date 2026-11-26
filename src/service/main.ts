import { claude } from "../agent/exceptions.js";
import { referenceShopfloor } from "../domain/shopfloor.js";
import { HttpErp } from "../erp/httpErp.js";
import { design } from "../lab/designs.js";
import { natsCloudSide } from "../transport/nats.js";
import { Orchestrator } from "../sync/cloud.js";
import { buildApp } from "./app.js";
import { DEFAULT_BINS, parseTokens } from "./config.js";
import { metrics } from "./telemetry.js";
import { startTracing } from "./tracing.js";

/** The cloud service: NATS JetStream to the edges, HTTP for intake and read models, ERP confirmations over HTTP. */
async function main() {
  const env = process.env;
  const stopTracing = startTracing(env);
  const { layout, resources } = referenceShopfloor();
  const link = await natsCloudSide(env.NATS_URL ?? "nats://localhost:4222");
  const m = metrics();
  let orc: Orchestrator | undefined;
  const erp = new HttpErp(env.ERP_BASE_URL ?? "http://localhost:8081", (id) => orc?.orders.get(id)?.order, env.ERP_AUTH);
  orc = new Orchestrator(resources, layout, link, erp, design("orchestrator").cloud, Date.now, {
    orderState: (r) => m.orderStates.inc({ state: r.state }),
    taskEvent: (_t, e) => m.taskEvents.inc({ edge: e.edgeId, kind: e.kind }),
    dispatched: (_t, rid) => m.dispatches.inc({ resource: rid, form_factor: resources.find((r) => r.id === rid)?.formFactor ?? "unknown" }),
  });
  const app = buildApp({
    orchestrator: orc,
    resources,
    bins: DEFAULT_BINS,
    tokens: parseTokens(env.API_TOKENS),
    metrics: m,
    logger: { level: env.LOG_LEVEL ?? "info" },
    ...(env.ANTHROPIC_API_KEY ? { complete: claude(env.ANTHROPIC_API_KEY) } : {}),
  });
  const timer = setInterval(() => orc!.tick(Date.now()), Number(env.TICK_MS ?? 1000));
  const stop = async () => {
    clearInterval(timer);
    await app.close();
    await link.close();
    await stopTracing?.();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await app.listen({ host: "0.0.0.0", port: Number(env.PORT ?? 8080) });
}

void main();
