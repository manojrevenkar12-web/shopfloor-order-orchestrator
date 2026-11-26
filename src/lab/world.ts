import type { Millis, Order } from "../domain/types.js";
import { RECIPES } from "../planner/recipes.js";
import { Rng } from "./engine.js";

export const DAY = 86_400_000;
export const MIN = 60_000;
/** Monday 5 January 2026, 00:00 UTC. */
export const LAB_START = Date.UTC(2026, 0, 5);

export interface Outage {
  scope: string; // edge id, "cloud" (all edges), "erp", or a resource id (breakdown)
  start: Millis;
  end: Millis;
}

export interface WorldParams {
  days: number;
  productionPerDay: number;
  transfersPerDay: number;
  erpResendRate: number;
  partitionsPerEdgePerMonth: number;
  cloudOutagesPerMonth: number;
  breakdownsPerAmrPerMonth: number;
  erpOutagesPerMonth: number;
}

export const DEFAULT_WORLD: WorldParams = {
  days: 364,
  productionPerDay: 110,
  transfersPerDay: 220,
  erpResendRate: 0.015,
  partitionsPerEdgePerMonth: 3,
  cloudOutagesPerMonth: 1,
  breakdownsPerAmrPerMonth: 1,
  erpOutagesPerMonth: 2,
};

export interface Arrival {
  at: Millis;
  order: Order;
  /** The ERP re-sends this order (timeout on its side) after this delay; undefined = sent once. */
  resendAfter?: Millis;
}

/**
 * One simulated year: the ERP/MES order stream (weekdays, three shifts, release bursts at shift
 * start), and every fault, all from one seed. Every design runs against the same world.
 */
export class World {
  readonly arrivals: Arrival[] = [];
  readonly outages: Outage[] = [];
  readonly end: Millis;

  constructor(
    readonly seed: number,
    readonly edges: string[],
    readonly amrs: string[],
    readonly params: WorldParams = DEFAULT_WORLD,
  ) {
    const rng = new Rng(seed);
    this.end = LAB_START + params.days * DAY;
    const products = Object.keys(RECIPES);
    const cells = ["C1-IN", "C2-IN", "C3-IN", "C4-IN", "OUT"];
    let n = 0;
    for (let d = 0; d < params.days; d++) {
      const dow = d % 7;
      if (dow >= 5) continue;
      const day0 = LAB_START + d * DAY;
      const emit = (at: Millis, order: Omit<Order, "orderId" | "receivedAt">) => {
        const id = order.source === "MES" ? `MES-${String(++n).padStart(7, "0")}` : `EWM-WT-${String(++n).padStart(8, "0")}`;
        const full: Order = { ...order, orderId: id, receivedAt: at };
        this.arrivals.push({ at, order: full, ...(rng.chance(params.erpResendRate) ? { resendAfter: rng.int(20, 120) * 1000 } : {}) });
      };
      for (let i = 0; i < params.productionPerDay; i++) {
        // 40 % of production orders are released in a burst in the 20 minutes after a shift starts.
        const shift = rng.int(0, 2);
        const at = rng.chance(0.4) ? day0 + shift * 8 * 3_600_000 + rng.int(0, 20) * MIN : day0 + Math.floor(rng.next() * DAY);
        const product = rng.pick(products);
        const quantity = rng.int(8, 48);
        emit(at, { source: "MES", kind: "production", product, quantity, weightKg: RECIPES[product]!.unitWeightKg * quantity, from: rng.chance(0.7) ? "WH" : "WH-02", to: "OUT", dueAt: at + 4 * 3_600_000 });
      }
      for (let i = 0; i < params.transfersPerDay; i++) {
        const at = day0 + Math.floor(rng.next() * DAY);
        const light = rng.chance(0.2);
        emit(at, { source: "EWM", kind: "transfer", product: "HU", quantity: 1, weightKg: light ? rng.int(2, 12) : rng.int(40, 450), from: rng.chance(0.6) ? "WH" : "WH-02", to: rng.pick(cells), dueAt: at + 90 * MIN });
      }
    }
    this.arrivals.sort((a, b) => a.at - b.at);
    const month = 30 * DAY;
    const total = params.days * DAY;
    const poisson = (scope: string, perMonth: number, duration: () => number, r: Rng) => {
      let t = 0;
      for (;;) {
        t += r.exp(month / perMonth);
        if (t >= total) break;
        const start = LAB_START + Math.floor(t);
        this.outages.push({ scope, start, end: start + Math.round(duration()) });
      }
    };
    const fr = rng.fork(17);
    for (const e of edges) poisson(e, params.partitionsPerEdgePerMonth, () => Math.min(60 * MIN, fr.lognormal(4 * MIN, 1.0)), fr);
    poisson("cloud", params.cloudOutagesPerMonth, () => fr.int(5, 25) * MIN, fr);
    for (const a of amrs) poisson(a, params.breakdownsPerAmrPerMonth, () => fr.int(30, 240) * MIN, fr);
    poisson("erp", params.erpOutagesPerMonth, () => fr.int(10, 60) * MIN, fr);
    this.outages.sort((a, b) => a.start - b.start);
  }
}
