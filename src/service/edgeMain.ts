import { referenceShopfloor } from "../domain/shopfloor.js";
import { natsEdgeSide } from "../transport/nats.js";
import { EdgeAgent, ROBUST_EDGE } from "../sync/edge.js";
import { SqliteEdgeStore } from "../sync/edgeStore.js";
import { TimedDriver } from "../sync/timedDriver.js";

/**
 * A demo edge gateway: the edge agent with its durable store on disk, a timed driver standing in
 * for NOVA OS or a VDA 5050 fleet. EDGE_ID picks which resources of the reference floor it runs.
 */
async function main() {
  const env = process.env;
  const edgeId = env.EDGE_ID ?? "nova-c1";
  const { resources } = referenceShopfloor();
  const mine = resources.filter((r) => r.edgeId === edgeId);
  if (mine.length === 0) throw new Error(`no resources behind edge ${edgeId}`);
  const link = await natsEdgeSide(env.NATS_URL ?? "nats://localhost:4222", edgeId);
  const store = new SqliteEdgeStore(env.EDGE_DB ?? `/data/${edgeId}.sqlite`);
  const driver = new TimedDriver(mine, Number(env.SPEEDUP ?? 60));
  const agent = new EdgeAgent(edgeId, mine.map((r) => r.id), link, driver, ROBUST_EDGE, store);
  driver.edge = agent;
  const timer = setInterval(() => {
    agent.tick(Date.now());
    agent.heartbeat(Date.now());
  }, 5_000);
  const stop = async () => {
    clearInterval(timer);
    await link.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
