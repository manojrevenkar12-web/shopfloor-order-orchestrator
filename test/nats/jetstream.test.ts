import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { referenceShopfloor } from "../../src/domain/shopfloor.js";
import type { ErpPort } from "../../src/erp/erp.js";
import { design } from "../../src/lab/designs.js";
import { Orchestrator } from "../../src/sync/cloud.js";
import { EdgeAgent, ROBUST_EDGE } from "../../src/sync/edge.js";
import { SqliteEdgeStore } from "../../src/sync/edgeStore.js";
import { TimedDriver } from "../../src/sync/timedDriver.js";
import { natsCloudSide, natsEdgeSide } from "../../src/transport/nats.js";

/** Needs a nats-server binary: NATS_SERVER_BIN or on PATH. CI downloads one. */
const BIN = process.env.NATS_SERVER_BIN ?? "nats-server";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const wait = async (cond: () => boolean, ms = 20_000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

let server: ChildProcess;
let url: string;
const dir = mkdtempSync(join(tmpdir(), "nats-"));

beforeAll(async () => {
  const port = await freePort();
  url = `nats://127.0.0.1:${port}`;
  server = spawn(BIN, ["-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
});

afterAll(() => {
  server?.kill();
});

const erp: ErpPort = { confirm: () => "ok" };

describe("orchestrator over NATS JetStream", () => {
  it("runs an order end to end through durable streams, and a resent command is executed once", async () => {
    const { layout, resources } = referenceShopfloor();
    const cloudLink = await natsCloudSide(url);
    const orc = new Orchestrator(resources, layout, cloudLink, erp, { ...design("orchestrator").cloud, dispatchResendMs: 200 });
    const edges: Array<{ agent: EdgeAgent; driver: TimedDriver; close: () => Promise<void> }> = [];
    for (const edgeId of new Set(resources.map((r) => r.edgeId))) {
      const mine = resources.filter((r) => r.edgeId === edgeId);
      const link = await natsEdgeSide(url, edgeId);
      const driver = new TimedDriver(mine, 3000);
      const store = new SqliteEdgeStore(join(dir, `${edgeId}.sqlite`));
      const agent = new EdgeAgent(edgeId, mine.map((r) => r.id), link, driver, ROBUST_EDGE, store);
      driver.edge = agent;
      edges.push({ agent, driver, close: async () => (await link.close(), store.close()) });
    }
    const timer = setInterval(() => {
      for (const e of edges) (e.agent.tick(Date.now()), e.agent.heartbeat(Date.now()));
      orc.tick(Date.now());
    }, 100);
    try {
      const now = Date.now();
      orc.intake({ orderId: "MES-NATS-1", source: "MES", kind: "production", product: "SNS-040", quantity: 10, weightKg: 3, from: "WH", to: "OUT", dueAt: now + 3_600_000, receivedAt: now }, now);
      orc.intake({ orderId: "EWM-NATS-2", source: "EWM", kind: "transfer", product: "HU", quantity: 1, weightKg: 120, from: "WH", to: "C1-IN", dueAt: now + 3_600_000, receivedAt: now }, now);
      await wait(() => [...orc.orders.values()].every((o) => o.state === "CONFIRMED"));
      // Every task ran exactly once although commands were re-sent every 200 ms until accepted.
      const started = edges.reduce((n, e) => n + e.driver.started, 0);
      expect(started).toBe(4);
      expect(cloudLink.publishErrors).toBe(0);
    } finally {
      clearInterval(timer);
      for (const e of edges) await e.close();
      await cloudLink.close();
    }
  });

  it("an edge's events survive the cloud being away: the durable consumer delivers them later", async () => {
    const { resources } = referenceShopfloor();
    const mine = resources.filter((r) => r.edgeId === "nova-c3");
    const edgeLink = await natsEdgeSide(url, "nova-c3");
    const driver = new TimedDriver(mine, 3000);
    const agent = new EdgeAgent("nova-c3", ["C3"], edgeLink, driver, ROBUST_EDGE, new SqliteEdgeStore(join(dir, "c3b.sqlite")));
    driver.edge = agent;
    // Cloud is not connected; publish a command straight onto the stream as the cloud would have.
    const { connect } = await import("@nats-io/transport-node");
    const { jetstream } = await import("@nats-io/jetstream");
    const nc = await connect({ servers: url });
    await jetstream(nc).publish("nova.edge.nova-c3.cmd", JSON.stringify({ type: "dispatch", commandId: "x1", epoch: 1, spec: { taskId: "OFF-1/2", orderId: "OFF-1", kind: "process", skills: ["inspect"], product: "SNS-040", quantity: 1, weightKg: 1, durationMs: 3000, resourceId: "C3" }, sentAt: Date.now() }), { msgID: "x1" });
    await wait(() => driver.started === 1);
    await new Promise((r) => setTimeout(r, 300));
    // Now the cloud comes up and reads what happened while it was away.
    const seen: string[] = [];
    const cloudLink = await natsCloudSide(url);
    cloudLink.onMessage((m) => m.type === "event" && m.taskId === "OFF-1/2" && seen.push(m.kind));
    await wait(() => seen.includes("done"));
    expect(seen.slice(0, 3)).toEqual(["accepted", "started", "done"]);
    await cloudLink.close();
    await edgeLink.close();
    await nc.drain();
  });
});
