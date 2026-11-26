import { canPerform, type Layout } from "../domain/shopfloor.js";
import type { Millis, Resource } from "../domain/types.js";
import type { Driver, EdgeAgent } from "../sync/edge.js";
import type { TaskSpec } from "../sync/protocol.js";
import { interpretState, toVdaOrder, topic, vehicleReady, type VehicleId } from "./translate.js";
import type { StateMessage } from "./types.js";

/**
 * Edge driver for an AMR/AGV fleet that speaks VDA 5050 over MQTT. It publishes orders and turns
 * vehicle states into task outcomes for the edge agent. `publish` is the MQTT client's publish.
 */
export class Vda5050Driver implements Driver {
  private readonly vehicles = new Map<string, { id: VehicleId; ready: boolean; location: string; orderId?: string; taskId?: string }>();
  private headerId = 0;
  edge?: EdgeAgent;

  constructor(
    private readonly resources: Resource[],
    private readonly layout: Layout,
    private readonly publish: (topic: string, payload: string) => void,
    manufacturer = "fleet",
    private readonly clock: () => Millis = Date.now,
  ) {
    for (const r of resources) this.vehicles.set(r.id, { id: { manufacturer, serialNumber: r.id }, ready: false, location: r.home });
  }

  accepts(spec: TaskSpec): boolean {
    const r = this.resources.find((x) => x.id === spec.resourceId);
    return !!r && spec.kind === "transport" && canPerform(r, spec.skills, spec.weightKg);
  }

  status(resourceId: string): { ready: boolean; location: string } {
    const v = this.vehicles.get(resourceId);
    return { ready: v?.ready ?? false, location: v?.location ?? "" };
  }

  start(spec: TaskSpec, now: Millis): void {
    const v = this.vehicles.get(spec.resourceId)!;
    const order = toVdaOrder(spec, 0, v.id, this.layout, ++this.headerId, new Date(now));
    v.orderId = order.orderId;
    v.taskId = spec.taskId;
    this.publish(topic(v.id, "order"), JSON.stringify(order));
  }

  /** Feed every message from `uagv/v2/+/+/state` here. */
  onState(state: StateMessage): void {
    const v = this.vehicles.get(state.serialNumber);
    if (!v) return;
    const wasReady = v.ready;
    v.ready = vehicleReady(state);
    if (state.lastNodeId) v.location = state.lastNodeId;
    const resourceId = state.serialNumber;
    if (wasReady && !v.ready) {
      this.edge?.resourceDown(resourceId, this.clock());
      delete v.orderId;
      delete v.taskId;
      return;
    }
    if (!v.orderId || !v.taskId) return;
    const out = interpretState(state, v.orderId);
    if (out.kind === "done" || out.kind === "failed") {
      const taskId = v.taskId;
      delete v.orderId;
      delete v.taskId;
      this.edge?.finished(resourceId, taskId, out.kind === "done", this.clock(), out.kind === "failed" ? out.reason : undefined);
    }
  }
}
