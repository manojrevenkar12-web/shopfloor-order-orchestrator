import type { LocationId, Millis, Skill, TaskKind } from "../domain/types.js";

/** What an edge needs to execute a task. Everything is resolved; the edge never looks anything up. */
export interface TaskSpec {
  taskId: string;
  orderId: string;
  kind: TaskKind;
  skills: Skill[];
  product: string;
  quantity: number;
  weightKg: number;
  durationMs: number;
  from?: LocationId;
  to?: LocationId;
  resourceId: string;
}

/** Cloud -> edge. Subject in NATS: `nova.edge.<edgeId>.cmd`. */
export type Command =
  | { type: "dispatch"; commandId: string; epoch: number; spec: TaskSpec; sentAt: Millis }
  | { type: "revoke"; commandId: string; taskId: string; epoch: number; sentAt: Millis }
  /** Acknowledges every edge event up to and including `upToSeq`; the edge can drop them from its outbox. */
  | { type: "ack"; upToSeq: number }
  /** After a reconnect: the tasks the cloud believes this edge holds, with their epochs. */
  | { type: "reconcile"; commandId: string; held: Array<{ taskId: string; epoch: number }>; sentAt: Millis };

export type TaskEventKind = "accepted" | "rejected" | "started" | "done" | "failed" | "revoked" | "unknown";

/** Edge -> cloud. Subject: `nova.cloud.events.<edgeId>`. `seq` is per edge, gap-free, starting at 1. */
export interface TaskEvent {
  type: "event";
  edgeId: string;
  seq: number;
  taskId: string;
  epoch: number;
  kind: TaskEventKind;
  resourceId: string;
  at: Millis;
  reason?: string;
}

export interface ResourceStatus {
  id: string;
  ready: boolean;
  location: LocationId;
  queued: number;
}

export interface Heartbeat {
  type: "heartbeat";
  edgeId: string;
  at: Millis;
  /** Highest event seq the edge has produced; lets the cloud notice gaps without waiting for traffic. */
  lastSeq: number;
  resources: ResourceStatus[];
}

export type EdgeMessage = TaskEvent | Heartbeat;

/** A bidirectional, unreliable channel between the cloud and the edges: messages may be lost, duplicated, delayed. */
export interface CloudSide {
  send(edgeId: string, cmd: Command): void;
  onMessage(handler: (msg: EdgeMessage) => void): void;
}

export interface EdgeSide {
  send(msg: EdgeMessage): void;
  onCommand(handler: (cmd: Command) => void): void;
}
