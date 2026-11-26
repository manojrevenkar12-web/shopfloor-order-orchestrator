import type { Millis } from "../domain/types.js";
import type { ConfirmResult, ErpPort } from "../erp/erp.js";
import type { Rng } from "./engine.js";
import { baseOrder } from "./plant.js";

/**
 * The ERP the confirmations go to. A call can fail before booking (unavailable) or book and
 * then lose its response (timeout) - the case where a retry without an idempotency key books twice.
 */
export class SimErp implements ErpPort {
  readonly bookings = new Map<string, Millis[]>();
  private readonly keys = new Set<string>();
  down = false;
  calls = 0;

  constructor(private readonly rng: Rng) {}

  confirm(orderId: string, key: string | undefined, at: Millis): ConfirmResult {
    this.calls++;
    if (this.down || this.rng.chance(0.005)) return "error";
    const base = baseOrder(orderId);
    const k = key ? key.replace(orderId, base) : undefined;
    if (!(k && this.keys.has(k))) {
      const list = this.bookings.get(base) ?? [];
      list.push(at);
      this.bookings.set(base, list);
      if (k) this.keys.add(k);
    }
    return this.rng.chance(0.01) ? "timeout" : "ok";
  }
}
