import { referenceShopfloor } from "../src/domain/shopfloor.js";
import type { Order } from "../src/domain/types.js";
import { Orchestrator, type OrchestratorConfig } from "../src/sync/cloud.js";
import { EdgeAgent, type EdgeConfig } from "../src/sync/edge.js";
import { MemoryEdgeStore } from "../src/sync/edgeStore.js";
import { Engine, Rng } from "../src/lab/engine.js";
import { PlantTruth, SimDriver } from "../src/lab/plant.js";
import { SimErp } from "../src/lab/simErp.js";
import { SimNetwork, type NetworkParams } from "../src/lab/simNetwork.js";

export const T0 = Date.UTC(2026, 0, 5, 6);

export function order(over: Partial<Order> = {}): Order {
  return { orderId: "MES-1", source: "MES", kind: "production", product: "BRK-100", quantity: 10, weightKg: 18, from: "WH", to: "OUT", dueAt: T0 + 4 * 3_600_000, receivedAt: T0, ...over };
}

/** A small shopfloor wired through the simulated network, for scenario tests. */
export function rig(cloudCfg: OrchestratorConfig, edgeCfg: EdgeConfig, net: Partial<NetworkParams> = {}, seed = 1) {
  const { layout, resources } = referenceShopfloor();
  const engine = new Engine();
  engine.now = T0;
  const rng = new Rng(seed);
  const network = new SimNetwork(engine, rng.fork(1), { latencyMs: [20, 40], lossRate: 0, duplicateRate: 0, ...net });
  const erp = new SimErp(new Rng(99));
  const truth = new PlantTruth();
  const clock = () => engine.now;
  const cloud = new Orchestrator(resources, layout, network.cloud(), erp, cloudCfg, clock);
  const agents = new Map<string, EdgeAgent>();
  const drivers = new Map<string, SimDriver>();
  for (const edgeId of new Set(resources.map((r) => r.edgeId))) {
    const rs = resources.filter((r) => r.edgeId === edgeId);
    const d = new SimDriver(rs, layout, engine, rng.fork(10 + agents.size), truth);
    const a = new EdgeAgent(edgeId, rs.map((r) => r.id), network.edge(edgeId), d, edgeCfg, new MemoryEdgeStore(), clock);
    d.edge = a;
    agents.set(edgeId, a);
    for (const r of rs) drivers.set(r.id, d);
  }
  const until = (t: number) => {
    const end = T0 + t;
    engine.every(5_000, engine.now, (now) => cloud.tick(now), end);
    for (const a of agents.values()) engine.every(5_000, engine.now + 1_000, (now) => (a.tick(now), a.heartbeat(now)), end);
    engine.run(end);
  };
  return { engine, network, cloud, agents, drivers, truth, erp, until, resources, layout };
}
