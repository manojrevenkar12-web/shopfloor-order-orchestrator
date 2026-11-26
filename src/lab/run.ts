import { referenceShopfloor } from "../domain/shopfloor.js";
import { decompose } from "../planner/decompose.js";
import { Orchestrator } from "../sync/cloud.js";
import { EdgeAgent } from "../sync/edge.js";
import { MemoryEdgeStore } from "../sync/edgeStore.js";
import type { Design } from "./designs.js";
import { Engine, Rng } from "./engine.js";
import { PlantTruth, SimDriver, baseOrder } from "./plant.js";
import { SimErp } from "./simErp.js";
import { SimNetwork } from "./simNetwork.js";
import { DAY, LAB_START, MIN, World, type WorldParams, DEFAULT_WORLD } from "./world.js";

export interface RunResult {
  design: string;
  seed: number;
  days: number;
  orders: number;
  completed: number;
  /** Orders physically complete, minutes from ERP release to the last task done. */
  leadP50Min: number;
  leadP95Min: number;
  latePct: number;
  /** Physical tasks executed more than once (material moved twice, a batch built twice). */
  duplicateExecutions: number;
  /** Orders released more than a day before the end that never physically finished. */
  stuckOrders: number;
  manualResets: number;
  erpDoubleBookings: number;
  erpMissing: number;
  erpLagP95Min: number;
  amrUtilisationPct: number;
  cellUtilisationPct: number;
  messages: number;
  kbPerDay: number;
  reassignedFromSilentEdges: number;
  reconciles: number;
  /** Lead time p95 of orders whose tasks touched an edge while it was cut off. */
  partitionLeadP95Min: number;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

/** Run one design through one simulated year. */
export function runDesign(design: Design, seed: number, params: WorldParams = DEFAULT_WORLD): RunResult {
  const { layout, resources } = referenceShopfloor();
  const edges = [...new Set(resources.map((r) => r.edgeId))];
  const amrs = resources.filter((r) => r.formFactor === "amr").map((r) => r.id);
  const world = new World(seed, edges, amrs, params);
  const engine = new Engine();
  engine.now = LAB_START - MIN;
  const rng = new Rng(seed * 7919 + 13);
  const net = new SimNetwork(engine, rng.fork(1));
  const erp = new SimErp(rng.fork(2));
  const truth = new PlantTruth();
  const clock = () => engine.now;
  const cloud = new Orchestrator(resources, layout, net.cloud(), erp, design.cloud, clock);
  const drivers = new Map<string, SimDriver>();
  const agents: EdgeAgent[] = [];
  for (const edgeId of edges) {
    const rs = resources.filter((r) => r.edgeId === edgeId);
    const driver = new SimDriver(rs, layout, engine, rng.fork(100 + agents.length), truth);
    const agent = new EdgeAgent(edgeId, rs.map((r) => r.id), net.edge(edgeId), driver, design.edge, new MemoryEdgeStore(), clock);
    driver.edge = agent;
    for (const r of rs) drivers.set(r.id, driver);
    agents.push(agent);
  }
  const end = world.end;
  // Orders from the ERP/MES (and the ERP's own re-sends after a timeout).
  for (const a of world.arrivals) {
    engine.at(a.at, () => cloud.intake(a.order, engine.now));
    if (a.resendAfter !== undefined) engine.at(a.at + a.resendAfter, () => cloud.intake(a.order, engine.now));
  }
  // Faults.
  const cutWindows = new Map<string, Array<[number, number]>>();
  for (const o of world.outages) {
    if (o.scope === "cloud") {
      engine.at(o.start, () => net.setCloudCut(true));
      engine.at(o.end, () => net.setCloudCut(false));
      for (const e of edges) cutWindows.set(e, [...(cutWindows.get(e) ?? []), [o.start, o.end]]);
    } else if (o.scope === "erp") {
      engine.at(o.start, () => (erp.down = true));
      engine.at(o.end, () => (erp.down = false));
    } else if (edges.includes(o.scope)) {
      engine.at(o.start, () => net.setCut(o.scope, true));
      engine.at(o.end, () => net.setCut(o.scope, false));
      cutWindows.set(o.scope, [...(cutWindows.get(o.scope) ?? []), [o.start, o.end]]);
    } else {
      engine.at(o.start, () => drivers.get(o.scope)?.breakdown(o.scope, o.end));
    }
  }
  // Control loops.
  engine.every(15_000, LAB_START - MIN, (t) => cloud.tick(t), end);
  agents.forEach((a, i) => {
    engine.every(15_000, LAB_START - MIN + 1_000 + i * 500, (t) => {
      a.tick(t);
      a.heartbeat(t);
    }, end);
  });
  engine.run(end);

  // ---- Score against the plant truth ----
  const orders = world.arrivals.map((a) => a.order);
  const lead: number[] = [];
  const partitionLead: number[] = [];
  let late = 0;
  let completed = 0;
  let stuck = 0;
  const physicalDone = new Map<string, number>();
  const touched = new Map<string, Set<string>>();
  for (const [taskId, rec] of cloud.tasks) {
    if (rec.assignee) {
      const edge = resources.find((r) => r.id === rec.assignee)!.edgeId;
      const o = baseOrder(rec.orderId);
      touched.set(o, (touched.get(o) ?? new Set()).add(edge));
    }
    void taskId;
  }
  for (const o of orders) {
    const keys = decompose(o).map((t) => t.taskId);
    const done = keys.map((k) => truth.firstDone.get(k));
    if (done.every((d) => d !== undefined)) {
      const at = Math.max(...(done as number[]));
      physicalDone.set(o.orderId, at);
      completed++;
      const minutes = (at - o.receivedAt) / MIN;
      lead.push(minutes);
      if (at > o.dueAt) late++;
      const hit = [...(touched.get(o.orderId) ?? [])].some((e) => (cutWindows.get(e) ?? []).some(([s, en]) => s < at && en > o.receivedAt));
      if (hit) partitionLead.push(minutes);
    } else if (o.receivedAt < end - DAY) {
      stuck++;
    }
  }
  let doubles = 0;
  let missing = 0;
  const erpLag: number[] = [];
  for (const [orderId, at] of physicalDone) {
    const b = erp.bookings.get(orderId) ?? [];
    if (b.length > 1) doubles += b.length - 1;
    if (b.length === 0 && at < end - DAY) missing++;
    if (b.length > 0) erpLag.push((Math.min(...b) - at) / MIN);
  }
  const span = end - LAB_START;
  const busy = (kind: string) => {
    const rs = resources.filter((r) => r.formFactor === kind);
    return (100 * rs.reduce((s, r) => s + (truth.busyMs.get(r.id) ?? 0), 0)) / (rs.length * span);
  };
  return {
    design: design.name,
    seed,
    days: params.days,
    orders: orders.length,
    completed,
    leadP50Min: pct(lead, 50),
    leadP95Min: pct(lead, 95),
    latePct: (100 * late) / Math.max(1, completed),
    duplicateExecutions: truth.duplicateExecutions,
    stuckOrders: stuck,
    manualResets: cloud.stats.manualResets,
    erpDoubleBookings: doubles,
    erpMissing: missing,
    erpLagP95Min: pct(erpLag, 95),
    amrUtilisationPct: busy("amr"),
    cellUtilisationPct: busy("stationary-cell"),
    messages: net.sent,
    kbPerDay: net.bytes / 1024 / params.days,
    reassignedFromSilentEdges: cloud.stats.reassignedFromSilentEdges,
    reconciles: cloud.stats.reconciles,
    partitionLeadP95Min: pct(partitionLead, 95),
  };
}
