import type { Millis } from "../domain/types.js";
import { MemoryEdgeStore, type EdgeStore } from "./edgeStore.js";
import type { Command, EdgeSide, Heartbeat, ResourceStatus, TaskEvent, TaskEventKind, TaskSpec } from "./protocol.js";

/** The physical side: a NOVA OS cell program, a VDA 5050 fleet, a simulator. */
export interface Driver {
  /** Can this resource take `spec` at all (skills, payload, mode)? */
  accepts(spec: TaskSpec): boolean;
  status(resourceId: string): { ready: boolean; location: string };
  /** Start executing. The driver calls `edge.finished` later. */
  start(spec: TaskSpec, now: Millis): void;
}

export interface EdgeConfig {
  /** Remember applied command ids; a redelivered dispatch is acknowledged again but not executed twice. */
  dedupeCommands: boolean;
  /** Keep the highest epoch per task and refuse anything older. */
  fencing: boolean;
  /** Keep events until the cloud acknowledges them and resend them; false = send once (lost while offline). */
  outbox: boolean;
  resendEveryMs: number;
}

export const ROBUST_EDGE: EdgeConfig = { dedupeCommands: true, fencing: true, outbox: true, resendEveryMs: 10_000 };

interface Queued {
  spec: TaskSpec;
  epoch: number;
}

/**
 * The edge gateway next to the robots (a NOVA OS instance, or the bridge to an AMR fleet).
 * It keeps a small local queue per resource and keeps working through it while the cloud is
 * unreachable; every state change becomes a numbered event that stays in the outbox until the
 * cloud acknowledges it.
 */
export class EdgeAgent {
  private readonly queues = new Map<string, Queued[]>();
  private readonly running = new Map<string, Queued>();
  private lastResend = 0;
  private lastSeqProduced = 0;

  constructor(
    readonly edgeId: string,
    readonly resourceIds: string[],
    private readonly link: EdgeSide,
    private readonly driver: Driver,
    private readonly config: EdgeConfig = ROBUST_EDGE,
    private readonly store: EdgeStore = new MemoryEdgeStore(),
    private readonly clock: () => Millis = Date.now,
  ) {
    for (const r of resourceIds) this.queues.set(r, []);
    link.onCommand((cmd) => this.onCommand(cmd, this.clock()));
    for (const e of store.unacked()) this.lastSeqProduced = Math.max(this.lastSeqProduced, e.seq);
  }

  onCommand(cmd: Command, now: Millis): void {
    switch (cmd.type) {
      case "ack":
        this.store.ackUpTo(cmd.upToSeq);
        return;
      case "dispatch":
        return this.dispatch(cmd, now);
      case "revoke":
        return this.revoke(cmd.commandId, cmd.taskId, cmd.epoch, now);
      case "reconcile":
        return this.reconcile(cmd.held, now);
    }
  }

  private dispatch(cmd: Extract<Command, { type: "dispatch" }>, now: Millis): void {
    const { spec, epoch } = cmd;
    if (this.config.dedupeCommands && this.store.seen(cmd.commandId)) {
      // Redelivery: say again where it stands, do nothing else.
      if (this.isHeld(spec.taskId)) this.emit(spec.taskId, epoch, "accepted", spec.resourceId, now, "duplicate delivery");
      return;
    }
    if (this.config.dedupeCommands) this.store.remember(cmd.commandId);
    if (this.config.fencing) {
      const known = this.store.epoch(spec.taskId);
      if (known !== undefined && epoch < known) return this.emit(spec.taskId, epoch, "rejected", spec.resourceId, now, `stale epoch ${epoch} < ${known}`);
      if (known !== undefined && epoch === known && this.isHeld(spec.taskId)) return this.emit(spec.taskId, epoch, "accepted", spec.resourceId, now, "already held");
      this.store.setEpoch(spec.taskId, epoch);
      // The cloud reset or re-sent work this edge already holds: take it over at the new epoch instead of doing it twice.
      if (known !== undefined && this.adopt(spec, epoch, now)) return;
    }
    const queue = this.queues.get(spec.resourceId);
    if (!queue) return this.emit(spec.taskId, epoch, "rejected", spec.resourceId, now, "resource not behind this edge");
    if (!this.driver.status(spec.resourceId).ready) return this.emit(spec.taskId, epoch, "rejected", spec.resourceId, now, "resource not ready");
    if (!this.driver.accepts(spec)) return this.emit(spec.taskId, epoch, "rejected", spec.resourceId, now, "capability or payload");
    queue.push({ spec, epoch });
    this.emit(spec.taskId, epoch, "accepted", spec.resourceId, now);
    this.startNext(spec.resourceId, now);
  }

  private revoke(commandId: string, taskId: string, epoch: number, now: Millis): void {
    if (this.config.dedupeCommands) {
      if (this.store.seen(commandId)) return;
      this.store.remember(commandId);
    }
    for (const [rid, q] of this.queues) {
      const i = q.findIndex((x) => x.spec.taskId === taskId);
      if (i >= 0) {
        const [item] = q.splice(i, 1);
        if (this.config.fencing) this.store.setEpoch(taskId, epoch);
        this.emit(taskId, item!.epoch, "revoked", rid, now);
        return;
      }
    }
    const run = [...this.running.values()].find((x) => x.spec.taskId === taskId);
    // A started task cannot be called back; say so, so the cloud keeps it pinned here.
    if (run) this.emit(taskId, run.epoch, "started", run.spec.resourceId, now, "already running, cannot revoke");
  }

  /** The cloud lists what it thinks this edge holds; anything the edge does not know is reported unknown and fenced off. */
  private reconcile(held: Array<{ taskId: string; epoch: number }>, now: Millis): void {
    for (const h of held) {
      const run = [...this.running.values()].find((x) => x.spec.taskId === h.taskId);
      if (run) {
        this.emit(h.taskId, run.epoch, "started", run.spec.resourceId, now, "reconcile");
        continue;
      }
      const q = [...this.queues.values()].flat().find((x) => x.spec.taskId === h.taskId);
      if (q) {
        this.emit(h.taskId, q.epoch, "accepted", q.spec.resourceId, now, "reconcile");
        continue;
      }
      const done = this.store.unacked().find((e) => e.taskId === h.taskId && (e.kind === "done" || e.kind === "failed"));
      if (done) continue; // its result is already in the outbox
      // Never received (or long finished and acknowledged). Fence it so a late copy of the command is refused.
      if (this.config.fencing) this.store.setEpoch(h.taskId, h.epoch + 1);
      this.emit(h.taskId, h.epoch, "unknown", "", now, "reconcile");
    }
  }

  /** Called by the driver when a task ends. */
  finished(resourceId: string, taskId: string, ok: boolean, now: Millis, reason?: string): void {
    const run = this.running.get(resourceId);
    if (!run || run.spec.taskId !== taskId) return;
    this.running.delete(resourceId);
    this.emit(taskId, run.epoch, ok ? "done" : "failed", resourceId, now, reason);
    this.startNext(resourceId, now);
  }

  /** The driver reports a resource went down (breakdown, e-stop, local mode): give back what it had not started. */
  resourceDown(resourceId: string, now: Millis): void {
    const q = this.queues.get(resourceId) ?? [];
    for (const item of q.splice(0)) this.emit(item.spec.taskId, item.epoch, "revoked", resourceId, now, "resource down");
    const run = this.running.get(resourceId);
    if (run) this.finished(resourceId, run.spec.taskId, false, now, "resource down");
  }

  tick(now: Millis): void {
    for (const r of this.resourceIds) this.startNext(r, now);
    if (this.config.outbox && now - this.lastResend >= this.config.resendEveryMs) {
      this.lastResend = now;
      for (const e of this.store.unacked()) this.link.send(e);
    }
  }

  heartbeat(now: Millis): Heartbeat {
    const resources: ResourceStatus[] = this.resourceIds.map((id) => {
      const s = this.driver.status(id);
      return { id, ready: s.ready, location: s.location, queued: (this.queues.get(id)?.length ?? 0) + (this.running.has(id) ? 1 : 0) };
    });
    const hb: Heartbeat = { type: "heartbeat", edgeId: this.edgeId, at: now, lastSeq: this.lastSeqProduced, resources };
    this.link.send(hb);
    return hb;
  }

  get outboxSize(): number {
    return this.store.unacked().length;
  }

  /** Move held work to a newer epoch. Returns false when the held copy was dropped and the new spec must be queued. */
  private adopt(spec: TaskSpec, epoch: number, now: Millis): boolean {
    for (const run of this.running.values()) {
      if (run.spec.taskId !== spec.taskId) continue;
      run.epoch = epoch;
      this.emit(spec.taskId, epoch, "started", run.spec.resourceId, now, "already running, adopted new epoch");
      return true;
    }
    for (const [rid, q] of this.queues) {
      const i = q.findIndex((x) => x.spec.taskId === spec.taskId);
      if (i < 0) continue;
      if (rid === spec.resourceId) {
        q[i] = { spec, epoch };
        this.emit(spec.taskId, epoch, "accepted", rid, now, "already queued, adopted new epoch");
        return true;
      }
      q.splice(i, 1); // queued for another resource; the new assignment replaces it
      return false;
    }
    return false;
  }

  private isHeld(taskId: string): boolean {
    return [...this.running.values()].some((x) => x.spec.taskId === taskId) || [...this.queues.values()].some((q) => q.some((x) => x.spec.taskId === taskId));
  }

  private startNext(resourceId: string, now: Millis): void {
    if (this.running.has(resourceId)) return;
    const q = this.queues.get(resourceId);
    if (!q || q.length === 0 || !this.driver.status(resourceId).ready) return;
    const next = q.shift()!;
    this.running.set(resourceId, next);
    this.emit(next.spec.taskId, next.epoch, "started", resourceId, now);
    this.driver.start(next.spec, now);
  }

  private emit(taskId: string, epoch: number, kind: TaskEventKind, resourceId: string, now: Millis, reason?: string): void {
    const seq = this.store.nextSeq();
    this.lastSeqProduced = seq;
    const event: TaskEvent = { type: "event", edgeId: this.edgeId, seq, taskId, epoch, kind, resourceId, at: now, ...(reason ? { reason } : {}) };
    if (this.config.outbox) this.store.append(event);
    this.link.send(event);
  }
}
