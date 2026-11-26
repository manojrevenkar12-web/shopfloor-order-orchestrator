import { canTask } from "../domain/lifecycle.js";
import { type Layout, isMobile } from "../domain/shopfloor.js";
import type { Millis, Order, OrderState, Resource, Task, TaskState } from "../domain/types.js";
import { allocate, durationOn, inputBuffer, reserveCell, type AllocationPolicy, type ResourceView } from "../dispatch/allocator.js";
import { ConfirmationOutbox, type ErpPort } from "../erp/erp.js";
import { decompose } from "../planner/decompose.js";
import type { CloudSide, Command, EdgeMessage, Heartbeat, TaskEvent, TaskSpec } from "./protocol.js";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("shopfloor-order-orchestrator");

export interface OrchestratorConfig {
  policy: AllocationPolicy;
  /** A re-sent ERP order (same orderId) is recognised; false = it becomes a second order. */
  idempotentIntake: boolean;
  /** Re-send a dispatch with the same command id (the edge can de-duplicate) or a fresh one. */
  stableCommandIds: boolean;
  /** Raise the epoch on every reassignment and put it on every command. */
  fencing: boolean;
  dispatchResendMs: number;
  /**
   * Silence after which work held by an edge is given to someone else. null = never: work an
   * edge accepted stays pinned to it until it reports, and the cloud reconciles on reconnect.
   */
  reassignSilentEdgeAfterMs: number | null;
  /** Apply each edge's events exactly once and in order (by per-edge sequence number). */
  orderedEvents: boolean;
  reconcileOnReconnect: boolean;
  /** After this much silence about a task, a supervisor resets it by hand (counted). */
  manualResetAfterMs: number;
  erpIdempotencyKeys: boolean;
  edgeOfflineAfterMs: number;
}

export interface OrderRecord {
  order: Order;
  state: OrderState;
  taskIds: string[];
  completedAt?: Millis;
  confirmedAt?: Millis;
}

export interface EdgeRecord {
  lastHeardAt: Millis;
  online: boolean;
  lastAppliedSeq: number;
  buffered: Map<number, TaskEvent>;
  ackedSent: number;
  status: Map<string, { ready: boolean; location: string; queued: number }>;
}

export interface OrchestratorStats {
  manualResets: number;
  reassignedFromSilentEdges: number;
  duplicateEventsIgnored: number;
  staleEventsIgnored: number;
  dispatchesSent: number;
  reconciles: number;
}

/** Hooks the service and the lab use to observe; none of them can change a decision. */
export interface OrchestratorObserver {
  orderState?(r: OrderRecord, at: Millis): void;
  taskEvent?(t: Task, e: TaskEvent): void;
  dispatched?(t: Task, resourceId: string, at: Millis): void;
}

/**
 * The cloud orchestration layer. It takes business orders, decomposes them into skill-based
 * tasks, allocates them to resources across the shopfloor, sends commands to the edges, applies
 * the edges' numbered events, and confirms finished orders to the ERP through an outbox.
 */
export class Orchestrator {
  readonly orders = new Map<string, OrderRecord>();
  readonly tasks = new Map<string, Task>();
  readonly edges = new Map<string, EdgeRecord>();
  readonly stats: OrchestratorStats = { manualResets: 0, reassignedFromSilentEdges: 0, duplicateEventsIgnored: 0, staleEventsIgnored: 0, dispatchesSent: 0, reconciles: 0 };
  private readonly resources = new Map<string, Resource>();
  private readonly lastNews = new Map<string, Millis>();
  private readonly pendingDispatch = new Map<string, { commandId: string; sentAt: Millis; resends: number }>();
  private readonly active = new Set<string>();
  private readonly confirmations: ConfirmationOutbox;
  private cmdCounter = 0;
  private duplicateIntake = 0;

  constructor(
    resources: Resource[],
    private readonly layout: Layout,
    private readonly link: CloudSide,
    erp: ErpPort,
    private readonly config: OrchestratorConfig,
    private readonly clock: () => Millis = Date.now,
    private readonly observer: OrchestratorObserver = {},
  ) {
    for (const r of resources) {
      this.resources.set(r.id, r);
      if (!this.edges.has(r.edgeId)) this.edges.set(r.edgeId, { lastHeardAt: -Infinity, online: false, lastAppliedSeq: 0, buffered: new Map(), ackedSent: 0, status: new Map() });
    }
    this.confirmations = new ConfirmationOutbox(erp, config.erpIdempotencyKeys);
    link.onMessage((m) => this.onMessage(m, this.clock()));
  }

  /** Accept an order from EWM/MES. Returns the order id it was stored under. */
  intake(order: Order, now: Millis = this.clock()): string {
    let id = order.orderId;
    if (this.orders.has(id)) {
      if (this.config.idempotentIntake) return id;
      this.duplicateIntake++;
      id = `${order.orderId}#${this.duplicateIntake}`;
    }
    const o = { ...order, orderId: id };
    const tasks = decompose(o);
    for (const t of tasks) {
      this.tasks.set(t.taskId, t);
      this.active.add(t.taskId);
      this.lastNews.set(t.taskId, now);
    }
    const rec: OrderRecord = { order: o, state: "PLANNED", taskIds: tasks.map((t) => t.taskId) };
    this.orders.set(id, rec);
    this.observer.orderState?.(rec, now);
    return id;
  }

  onMessage(msg: EdgeMessage, now: Millis): void {
    const edge = this.edges.get(msg.edgeId);
    if (!edge) return;
    const wasOnline = edge.online;
    edge.lastHeardAt = now;
    edge.online = true;
    if (!wasOnline && this.config.reconcileOnReconnect) this.reconcile(msg.edgeId, now);
    if (msg.type === "heartbeat") return this.onHeartbeat(msg, edge);
    if (!this.config.orderedEvents) return this.apply(msg, now);
    if (msg.seq <= edge.lastAppliedSeq || edge.buffered.has(msg.seq)) {
      this.stats.duplicateEventsIgnored++;
      return;
    }
    edge.buffered.set(msg.seq, msg);
    let next = edge.buffered.get(edge.lastAppliedSeq + 1);
    while (next) {
      edge.buffered.delete(next.seq);
      edge.lastAppliedSeq = next.seq;
      this.apply(next, now);
      next = edge.buffered.get(edge.lastAppliedSeq + 1);
    }
  }

  private onHeartbeat(hb: Heartbeat, edge: EdgeRecord): void {
    for (const r of hb.resources) edge.status.set(r.id, { ready: r.ready, location: r.location, queued: r.queued });
  }

  private apply(e: TaskEvent, now: Millis): void {
    const t = this.tasks.get(e.taskId);
    if (!t) return;
    if (this.config.fencing && e.epoch < t.epoch) {
      this.stats.staleEventsIgnored++;
      return;
    }
    this.lastNews.set(t.taskId, now);
    this.observer.taskEvent?.(t, e);
    switch (e.kind) {
      case "accepted":
        this.pendingDispatch.delete(t.taskId);
        this.move(t, "ACCEPTED");
        break;
      case "started":
        this.pendingDispatch.delete(t.taskId);
        this.move(t, "RUNNING");
        break;
      case "rejected":
      case "revoked":
      case "unknown":
        if (t.state === "DONE") break;
        this.pendingDispatch.delete(t.taskId);
        if (e.kind !== "rejected" || t.assignee === e.resourceId || !this.config.fencing) this.requeue(t);
        break;
      case "done":
        this.pendingDispatch.delete(t.taskId);
        if (t.state !== "DONE") {
          // Leave the active set only once the task really is DONE; otherwise it would be lost to every later tick.
          if (!this.move(t, "DONE")) break;
          t.doneAt = e.at;
          this.active.delete(t.taskId);
          this.checkOrder(t.orderId, now);
        }
        break;
      case "failed":
        if (t.state === "DONE") break;
        this.pendingDispatch.delete(t.taskId);
        t.attempts++;
        if (t.attempts >= 3) {
          this.move(t, "FAILED");
          this.setOrder(t.orderId, "ON_HOLD", now);
        } else {
          this.requeue(t);
        }
        break;
    }
  }

  private move(t: Task, to: TaskState): boolean {
    if (!canTask(t.state, to)) return false;
    t.state = to;
    return true;
  }

  private requeue(t: Task): void {
    t.state = "READY";
    delete t.assignee;
    delete t.assignedAt;
    this.active.add(t.taskId);
  }

  private checkOrder(orderId: string, now: Millis): void {
    const rec = this.orders.get(orderId);
    if (!rec) return;
    if (rec.state === "PLANNED") this.setOrder(orderId, "IN_PROGRESS", now);
    if (rec.taskIds.every((id) => this.tasks.get(id)?.state === "DONE") && (rec.state === "IN_PROGRESS" || rec.state === "ON_HOLD")) {
      rec.completedAt = Math.max(...rec.taskIds.map((id) => this.tasks.get(id)!.doneAt ?? now));
      this.setOrder(orderId, "COMPLETED", now);
      this.confirmations.enqueue(orderId, now);
    }
  }

  private setOrder(orderId: string, to: OrderState, now: Millis): void {
    const rec = this.orders.get(orderId);
    if (!rec || rec.state === to) return;
    if (rec.state === "ON_HOLD" && to === "COMPLETED") rec.state = "IN_PROGRESS";
    rec.state = to;
    this.observer.orderState?.(rec, now);
  }

  /** One control cycle: release, bind, allocate, re-send, reassign, reset, confirm, acknowledge. */
  tick(now: Millis = this.clock()): void {
    for (const [, edge] of this.edges) {
      if (edge.online && now - edge.lastHeardAt > this.config.edgeOfflineAfterMs) edge.online = false;
    }
    const views = this.views();
    const ready: Task[] = [];
    for (const id of this.active) {
      const t = this.tasks.get(id)!;
      if (t.state === "PENDING" && t.dependsOn.every((d) => this.tasks.get(d)?.state === "DONE")) t.state = "READY";
      if (t.state === "READY") {
        if (t.bindToOf && !this.bind(t, views)) continue;
        ready.push(t);
      }
    }
    for (const { task, resourceId } of allocate(ready, views, this.layout, this.config.policy, (t) => this.orders.get(t.orderId)?.order.dueAt ?? 0)) {
      this.assign(task, resourceId, now);
    }
    this.resendAndReassign(now);
    for (const orderId of this.confirmations.flush(now)) {
      const rec = this.orders.get(orderId);
      if (rec) {
        rec.confirmedAt = now;
        this.setOrder(orderId, "CONFIRMED", now);
      }
    }
    if (this.config.orderedEvents) {
      for (const [edgeId, edge] of this.edges) {
        if (edge.lastAppliedSeq > edge.ackedSent || (edge.online && edge.lastAppliedSeq > 0 && now - edge.lastHeardAt < 1000)) {
          this.link.send(edgeId, { type: "ack", upToSeq: edge.lastAppliedSeq });
          edge.ackedSent = edge.lastAppliedSeq;
        }
      }
    }
  }

  /** Resolve late-bound locations; reserve a cell for the process step if it has none. */
  private bind(t: Task, views: ResourceView[]): boolean {
    const proc = this.tasks.get(t.bindToOf!.taskId);
    if (!proc) return false;
    if (!proc.reservedFor) {
      const cell = reserveCell(proc, views, this.config.policy);
      if (!cell) return false;
      proc.reservedFor = cell;
      const v = views.find((x) => x.resource.id === cell);
      if (v) v.backlogMs += proc.durationMs;
    }
    const cell = this.resources.get(proc.reservedFor);
    if (!cell) return false;
    if (t.bindToOf!.end === "to") t.to = isMobile(cell) ? cell.home : inputBuffer(cell.home);
    else t.from = cell.home;
    return true;
  }

  private assign(t: Task, resourceId: string, now: Millis): void {
    const r = this.resources.get(resourceId)!;
    // A span per dispatch decision; trace context links it to the intake span of the order in the service.
    tracer.startSpan("dispatch", { attributes: { "task.id": t.taskId, "resource.id": resourceId, "edge.id": r.edgeId, "task.kind": t.kind } }).end();
    if (this.config.fencing) t.epoch++;
    t.state = "ASSIGNED";
    t.assignee = resourceId;
    t.assignedAt = now;
    this.lastNews.set(t.taskId, now);
    const commandId = `${t.taskId}@${t.epoch}#${++this.cmdCounter}`;
    this.pendingDispatch.set(t.taskId, { commandId, sentAt: now, resends: 0 });
    this.sendDispatch(t, r, commandId, now);
    this.observer.dispatched?.(t, resourceId, now);
  }

  private sendDispatch(t: Task, r: Resource, commandId: string, now: Millis): void {
    const spec: TaskSpec = {
      taskId: t.taskId,
      orderId: t.orderId,
      kind: t.kind,
      skills: t.skills,
      product: t.product,
      quantity: t.quantity,
      weightKg: t.weightKg,
      durationMs: durationOn(t, r),
      resourceId: r.id,
      ...(t.from ? { from: t.from } : {}),
      ...(t.to ? { to: t.to } : {}),
    };
    this.stats.dispatchesSent++;
    this.link.send(r.edgeId, { type: "dispatch", commandId, epoch: t.epoch, spec, sentAt: now });
  }

  private resendAndReassign(now: Millis): void {
    for (const id of this.active) {
      const t = this.tasks.get(id)!;
      if (!t.assignee || (t.state !== "ASSIGNED" && t.state !== "ACCEPTED" && t.state !== "RUNNING")) continue;
      const r = this.resources.get(t.assignee)!;
      const edge = this.edges.get(r.edgeId)!;
      const news = this.lastNews.get(id) ?? now;
      // A supervisor steps in when nothing has been heard about a task for too long.
      if (now - news >= this.config.manualResetAfterMs) {
        this.stats.manualResets++;
        this.pendingDispatch.delete(id);
        this.requeue(t);
        this.lastNews.set(id, now);
        continue;
      }
      if (this.config.reassignSilentEdgeAfterMs !== null && !edge.online && now - edge.lastHeardAt >= this.config.reassignSilentEdgeAfterMs) {
        this.stats.reassignedFromSilentEdges++;
        this.pendingDispatch.delete(id);
        this.requeue(t);
        continue;
      }
      const pd = this.pendingDispatch.get(id);
      if (t.state === "ASSIGNED" && pd && now - pd.sentAt >= this.config.dispatchResendMs && edge.online) {
        pd.resends++;
        pd.sentAt = now;
        if (!this.config.stableCommandIds) pd.commandId = `${t.taskId}@${t.epoch}#${++this.cmdCounter}`;
        this.sendDispatch(t, r, pd.commandId, now);
      }
    }
  }

  private reconcile(edgeId: string, now: Millis): void {
    const held: Array<{ taskId: string; epoch: number }> = [];
    for (const id of this.active) {
      const t = this.tasks.get(id)!;
      if (t.assignee && this.resources.get(t.assignee)?.edgeId === edgeId && (t.state === "ASSIGNED" || t.state === "ACCEPTED" || t.state === "RUNNING")) {
        held.push({ taskId: t.taskId, epoch: t.epoch });
      }
    }
    if (held.length === 0) return;
    this.stats.reconciles++;
    const cmd: Command = { type: "reconcile", commandId: `reconcile:${edgeId}:${++this.cmdCounter}`, held, sentAt: now };
    this.link.send(edgeId, cmd);
  }

  /** What the allocator may know: edge-reported readiness and location, plus our own bookkeeping of load. */
  views(): ResourceView[] {
    const load = new Map<string, { n: number; ms: number }>();
    for (const id of this.active) {
      const t = this.tasks.get(id)!;
      if (t.state === "DONE") continue;
      if (t.assignee && t.state !== "READY") {
        const l = load.get(t.assignee) ?? { n: 0, ms: 0 };
        l.n++;
        l.ms += t.durationMs;
        load.set(t.assignee, l);
      } else if (t.kind === "process" && t.reservedFor) {
        // Reserved but not yet assigned: counts as backlog, so reservations spread across cells.
        const l = load.get(t.reservedFor) ?? { n: 0, ms: 0 };
        l.ms += t.durationMs;
        load.set(t.reservedFor, l);
      }
    }
    return [...this.resources.values()].map((r) => {
      const edge = this.edges.get(r.edgeId)!;
      const st = edge.status.get(r.id);
      const l = load.get(r.id) ?? { n: 0, ms: 0 };
      return { resource: r, available: edge.online && (st?.ready ?? false), location: st?.location ?? r.home, load: l.n, backlogMs: l.ms };
    });
  }

  get pendingConfirmations(): number {
    return this.confirmations.size;
  }

  get activeTasks(): number {
    return this.active.size;
  }
}
