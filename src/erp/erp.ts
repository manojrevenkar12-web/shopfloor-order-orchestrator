import type { Millis } from "../domain/types.js";

export type ConfirmResult = "ok" | "timeout" | "error";

/**
 * The ERP side we report back to: an EWM warehouse-task confirmation or an MES operation
 * confirmation. `idempotencyKey` is what makes a retry after a timeout safe; without it, a
 * retried call whose first response was lost books the goods movement twice.
 */
export interface ErpPort {
  confirm(orderId: string, idempotencyKey: string | undefined, at: Millis): ConfirmResult | Promise<ConfirmResult>;
}

interface Pending {
  attempts: number;
  nextAt: Millis;
  inFlight: boolean;
}

/**
 * Confirmations from the cloud to the ERP, kept until the ERP accepted them. Retries use the
 * same key, so the ERP books each order once. Works with a synchronous port (the lab) and an
 * HTTP one (the service).
 */
export class ConfirmationOutbox {
  private readonly pending = new Map<string, Pending>();
  private settled: string[] = [];

  constructor(
    private readonly erp: ErpPort,
    private readonly useKeys: boolean,
    private readonly retryEveryMs = 60_000,
  ) {}

  enqueue(orderId: string, now: Millis): void {
    if (!this.pending.has(orderId)) this.pending.set(orderId, { attempts: 0, nextAt: now, inFlight: false });
  }

  /** Returns the orders the ERP accepted since the last flush. */
  flush(now: Millis): string[] {
    const accepted = this.settled;
    this.settled = [];
    for (const [orderId, p] of this.pending) {
      if (p.inFlight || p.nextAt > now) continue;
      p.attempts++;
      const r = this.erp.confirm(orderId, this.useKeys ? `confirm:${orderId}` : undefined, now);
      if (typeof r === "string") {
        this.settle(orderId, p, r, now, accepted);
      } else {
        p.inFlight = true;
        r.catch(() => "error" as const).then((res) => {
          p.inFlight = false;
          this.settle(orderId, p, res, now, this.settled);
        });
      }
    }
    return accepted;
  }

  private settle(orderId: string, p: Pending, r: ConfirmResult, now: Millis, into: string[]): void {
    if (r === "ok") {
      this.pending.delete(orderId);
      into.push(orderId);
    } else {
      p.nextAt = now + this.retryEveryMs * Math.min(8, 2 ** (p.attempts - 1));
    }
  }

  get size(): number {
    return this.pending.size;
  }
}
