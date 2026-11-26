import type { Order } from "../domain/types.js";
import { confirmationFor } from "../intake/adapters.js";
import type { ConfirmResult, ErpPort } from "./erp.js";

/** Confirms over HTTP (EWM OData action or MES endpoint) with the idempotency key as a header. */
export class HttpErp implements ErpPort {
  constructor(
    private readonly baseUrl: string,
    private readonly orderOf: (orderId: string) => Order | undefined,
    private readonly authHeader?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async confirm(orderId: string, idempotencyKey: string | undefined, at: number): Promise<ConfirmResult> {
    const order = this.orderOf(orderId);
    if (!order) return "error";
    const req = confirmationFor(order, at);
    const headers: Record<string, string> = { ...req.headers };
    if (!idempotencyKey) delete headers["Idempotency-Key"];
    if (this.authHeader) headers["Authorization"] = this.authHeader;
    try {
      const res = await fetch(this.baseUrl + req.path, { method: req.method, headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(this.timeoutMs) });
      // 409 = the ERP already booked this key: that is success for us.
      return res.ok || res.status === 409 ? "ok" : "error";
    } catch (e) {
      return (e as Error).name === "TimeoutError" ? "timeout" : "error";
    }
  }
}
