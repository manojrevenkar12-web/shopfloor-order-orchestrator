import type { Layout } from "../domain/shopfloor.js";
import type { TaskSpec } from "../sync/protocol.js";
import type { OrderMessage, StateMessage } from "./types.js";

export const VDA_VERSION = "2.0.0";

export interface VehicleId {
  manufacturer: string;
  serialNumber: string;
}

export function topic(v: VehicleId, name: "order" | "state" | "instantActions" | "connection"): string {
  return `uagv/v2/${v.manufacturer}/${v.serialNumber}/${name}`;
}

/**
 * A transport task becomes a VDA 5050 order: pickup node (pick, HARD) -> edge -> drop node
 * (drop, HARD). Node sequence ids are even and edge ids odd, as the standard requires. The order
 * id carries the epoch, so a reassigned task is a new VDA order and an old one can never be
 * extended by mistake.
 */
export function toVdaOrder(spec: TaskSpec, epoch: number, v: VehicleId, layout: Layout, headerId: number, now: Date, mapId = "floor-1"): OrderMessage {
  if (spec.kind !== "transport" || !spec.from || !spec.to) throw new Error(`task ${spec.taskId} is not a bound transport`);
  const pos = (loc: string) => {
    const p = layout.locations[loc];
    if (!p) throw new Error(`no position for ${loc}`);
    return { x: p.x, y: p.y, mapId };
  };
  const load = [{ key: "loadId", value: spec.taskId }, { key: "weightKg", value: spec.weightKg }];
  return {
    headerId,
    timestamp: now.toISOString(),
    version: VDA_VERSION,
    manufacturer: v.manufacturer,
    serialNumber: v.serialNumber,
    orderId: `${spec.taskId}@${epoch}`,
    orderUpdateId: 0,
    nodes: [
      { nodeId: spec.from, sequenceId: 0, released: true, nodePosition: pos(spec.from), actions: [{ actionType: "pick", actionId: `${spec.taskId}@${epoch}:pick`, blockingType: "HARD", actionParameters: load }] },
      { nodeId: spec.to, sequenceId: 2, released: true, nodePosition: pos(spec.to), actions: [{ actionType: "drop", actionId: `${spec.taskId}@${epoch}:drop`, blockingType: "HARD", actionParameters: load }] },
    ],
    edges: [{ edgeId: `${spec.from}->${spec.to}`, sequenceId: 1, released: true, startNodeId: spec.from, endNodeId: spec.to, actions: [] }],
  };
}

export type VdaOutcome = { kind: "none" } | { kind: "started" } | { kind: "done"; location: string } | { kind: "failed"; reason: string };

/** What a vehicle state means for the task behind `orderId`. */
export function interpretState(state: StateMessage, orderId: string): VdaOutcome {
  if (state.orderId !== orderId) return { kind: "none" };
  const fatal = state.errors.find((e) => e.errorLevel === "FATAL");
  if (fatal) return { kind: "failed", reason: `${fatal.errorType}${fatal.errorDescription ? `: ${fatal.errorDescription}` : ""}` };
  const pick = state.actionStates.find((a) => a.actionId === `${orderId}:pick`);
  const drop = state.actionStates.find((a) => a.actionId === `${orderId}:drop`);
  if (pick?.actionStatus === "FAILED" || drop?.actionStatus === "FAILED") return { kind: "failed", reason: (drop ?? pick)?.resultDescription ?? "action failed" };
  if (drop?.actionStatus === "FINISHED") return { kind: "done", location: state.lastNodeId };
  if (state.driving || (pick && pick.actionStatus !== "WAITING")) return { kind: "started" };
  return { kind: "none" };
}

/** A vehicle can take work only in automatic mode without a fatal error. */
export function vehicleReady(state: StateMessage): boolean {
  return state.operatingMode === "AUTOMATIC" && !state.errors.some((e) => e.errorLevel === "FATAL");
}
