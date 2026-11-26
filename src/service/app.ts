import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { explain, factsFor, stuckOrders, type Complete } from "../agent/exceptions.js";
import type { Resource } from "../domain/types.js";
import { fromEwm, fromMes, UnmappedBin, type BinMap } from "../intake/adapters.js";
import type { Orchestrator } from "../sync/cloud.js";
import { traced, type Metrics } from "./telemetry.js";

export type Role = "erp" | "viewer" | "supervisor";

export interface AppOptions {
  orchestrator: Orchestrator;
  resources: Resource[];
  bins: BinMap;
  /** bearer token -> role */
  tokens: Record<string, Role>;
  metrics: Metrics;
  clock?: () => number;
  complete?: Complete;
  logger?: boolean | object;
}

const can: Record<Role, Role[]> = { erp: ["erp"], viewer: ["viewer", "supervisor"], supervisor: ["supervisor"] };

/**
 * The orchestrator's HTTP surface: intake from EWM and the MES (role erp), read models for the
 * shopfloor (viewer), and the exception list with explanations (viewer). Nothing here can command
 * a robot directly: all work goes through intake and the orchestrator.
 */
export function buildApp(o: AppOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false });
  const clock = o.clock ?? Date.now;
  const edgeOf = (rid: string) => o.resources.find((r) => r.id === rid)?.edgeId;

  const guard = (need: Role) => async (req: FastifyRequest) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const role = token ? o.tokens[token] : undefined;
    if (!role) throw Object.assign(new Error("missing or unknown token"), { statusCode: 401 });
    if (!can[need].includes(role)) throw Object.assign(new Error(`role ${role} may not do this`), { statusCode: 403 });
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "invalid payload", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (err instanceof UnmappedBin) return reply.status(422).send({ error: err.message });
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(code).send({ error: code === 500 ? "internal error" : (err as Error).message });
  });

  const intake = (source: "EWM" | "MES") => async (req: FastifyRequest) =>
    traced("intake", { source }, (span) => {
      const now = clock();
      const order = source === "EWM" ? fromEwm(req.body, o.bins, now) : fromMes(req.body, now);
      const duplicate = o.orchestrator.orders.has(order.orderId);
      const id = o.orchestrator.intake(order, now);
      span.setAttribute("order.id", id);
      o.metrics.ordersReceived.inc({ source, duplicate: String(duplicate) });
      return { orderId: id, duplicate, tasks: o.orchestrator.orders.get(id)!.taskIds };
    });

  app.post("/v1/intake/ewm", { preHandler: guard("erp") }, async (req, reply) => reply.status(202).send(await intake("EWM")(req)));
  app.post("/v1/intake/mes", { preHandler: guard("erp") }, async (req, reply) => reply.status(202).send(await intake("MES")(req)));

  app.get<{ Params: { id: string } }>("/v1/orders/:id", { preHandler: guard("viewer") }, async (req, reply) => {
    const rec = o.orchestrator.orders.get(req.params.id);
    if (!rec) return reply.status(404).send({ error: "unknown order" });
    return { ...rec, tasks: rec.taskIds.map((t) => o.orchestrator.tasks.get(t)) };
  });

  app.get<{ Querystring: { state?: string; limit?: string } }>("/v1/orders", { preHandler: guard("viewer") }, async (req) => {
    const limit = Math.min(500, Number(req.query.limit ?? 100));
    const out = [];
    for (const rec of o.orchestrator.orders.values()) {
      if (req.query.state && rec.state !== req.query.state) continue;
      out.push({ orderId: rec.order.orderId, state: rec.state, source: rec.order.source, dueAt: rec.order.dueAt });
      if (out.length >= limit) break;
    }
    return out;
  });

  app.get<{ Params: { id: string } }>("/v1/orders/:id/explanation", { preHandler: guard("viewer") }, async (req, reply) => {
    const facts = factsFor(o.orchestrator, req.params.id, clock(), edgeOf);
    if (!facts) return reply.status(404).send({ error: "unknown order" });
    return { facts, explanation: await explain(facts, o.complete) };
  });

  app.get("/v1/exceptions", { preHandler: guard("viewer") }, async () => {
    const now = clock();
    return Promise.all(
      stuckOrders(o.orchestrator, now)
        .slice(0, 50)
        .map(async (id) => {
          const facts = factsFor(o.orchestrator, id, now, edgeOf)!;
          return { orderId: id, explanation: (await explain(facts)).text };
        }),
    );
  });

  app.get("/v1/resources", { preHandler: guard("viewer") }, async () =>
    o.orchestrator.views().map((v) => ({ id: v.resource.id, formFactor: v.resource.formFactor, edge: v.resource.edgeId, skills: v.resource.capabilities.map((c) => c.skill), available: v.available, location: v.location, load: v.load })),
  );

  app.get("/v1/edges", { preHandler: guard("viewer") }, async () =>
    [...o.orchestrator.edges].map(([id, e]) => ({ id, online: e.online, lastHeardAt: Number.isFinite(e.lastHeardAt) ? e.lastHeardAt : null, lastAppliedSeq: e.lastAppliedSeq, bufferedOutOfOrder: e.buffered.size })),
  );

  app.get("/metrics", async (_req, reply) => {
    o.metrics.activeTasks.set(o.orchestrator.activeTasks);
    o.metrics.pendingConfirmations.set(o.orchestrator.pendingConfirmations);
    o.metrics.duplicatesIgnored.set(o.orchestrator.stats.duplicateEventsIgnored);
    for (const [id, e] of o.orchestrator.edges) o.metrics.edgeOnline.set({ edge: id }, e.online ? 1 : 0);
    reply.header("content-type", o.metrics.registry.contentType);
    return o.metrics.registry.metrics();
  });

  app.get("/healthz", async () => ({ ok: true }));
  return app;
}
