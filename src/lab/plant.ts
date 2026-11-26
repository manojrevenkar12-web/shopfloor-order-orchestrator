import { canPerform, isMobile, type Layout } from "../domain/shopfloor.js";
import type { Millis, Resource } from "../domain/types.js";
import { travelMs } from "../dispatch/allocator.js";
import type { Driver, EdgeAgent } from "../sync/edge.js";
import type { TaskSpec } from "../sync/protocol.js";
import type { Engine, Rng } from "./engine.js";

/** The business key of a task: duplicated orders ("X#1") count against the order they copy. */
export const baseKey = (taskId: string) => taskId.replace(/#\d+(?=\/)/, "");
export const baseOrder = (orderId: string) => orderId.replace(/#\d+$/, "");

/**
 * The physical truth of the shopfloor, which no design can see directly: what was really
 * executed, how often, and when. The lab's referee.
 */
export class PlantTruth {
  /** Successful executions per business task key. */
  readonly executions = new Map<string, number>();
  readonly firstDone = new Map<string, Millis>();
  readonly busyMs = new Map<string, number>();

  record(spec: TaskSpec, start: Millis, end: Millis): void {
    const key = baseKey(spec.taskId);
    this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
    if (!this.firstDone.has(key)) this.firstDone.set(key, end);
    this.busyMs.set(spec.resourceId, (this.busyMs.get(spec.resourceId) ?? 0) + (end - start));
  }

  get duplicateExecutions(): number {
    let d = 0;
    for (const n of this.executions.values()) d += n - 1;
    return d;
  }
}

/** A simulated NOVA OS cell or AMR behind one edge: executes tasks with travel, durations, failures and breakdowns. */
export class SimDriver implements Driver {
  private readonly state = new Map<string, { location: string; ready: boolean; runId: number }>();
  edge?: EdgeAgent;

  constructor(
    private readonly resources: Resource[],
    private readonly layout: Layout,
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly truth: PlantTruth,
  ) {
    for (const r of resources) this.state.set(r.id, { location: r.home, ready: true, runId: 0 });
  }

  accepts(spec: TaskSpec): boolean {
    const r = this.resources.find((x) => x.id === spec.resourceId);
    return r !== undefined && canPerform(r, spec.skills, spec.weightKg);
  }

  status(resourceId: string): { ready: boolean; location: string } {
    const s = this.state.get(resourceId)!;
    return { ready: s.ready, location: s.location };
  }

  start(spec: TaskSpec, now: Millis): void {
    const r = this.resources.find((x) => x.id === spec.resourceId)!;
    const s = this.state.get(r.id)!;
    const runId = ++s.runId;
    let duration = spec.durationMs;
    if (isMobile(r) && spec.from && spec.to) duration += travelMs(this.layout, r, s.location, spec.from, spec.to);
    duration = Math.round(duration * (0.9 + 0.25 * this.rng.next()));
    const fails = this.rng.chance(spec.kind === "process" ? 0.015 : 0.003);
    const end = now + (fails ? Math.round(duration / 2) : duration);
    this.engine.at(end, () => {
      if (s.runId !== runId || !s.ready) return; // aborted by a breakdown
      if (!fails) {
        if (isMobile(r) && spec.to) s.location = spec.to;
        this.truth.record(spec, now, end);
      }
      this.edge?.finished(r.id, spec.taskId, !fails, this.engine.now, fails ? "execution fault" : undefined);
    });
  }

  breakdown(resourceId: string, until: Millis): void {
    const s = this.state.get(resourceId);
    if (!s || !s.ready) return;
    s.ready = false;
    s.runId++;
    this.edge?.resourceDown(resourceId, this.engine.now);
    this.engine.at(until, () => {
      s.ready = true;
    });
  }
}
