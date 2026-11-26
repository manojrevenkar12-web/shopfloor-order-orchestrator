import type { Millis } from "../domain/types.js";
import type { Driver, EdgeAgent } from "./edge.js";
import type { TaskSpec } from "./protocol.js";

/**
 * A stand-in for a NOVA OS cell program or a fleet: finishes each task after its duration
 * divided by `speedup`. Used by the demo edge and the integration tests.
 */
export class TimedDriver implements Driver {
  private readonly ready = new Map<string, boolean>();
  private readonly location = new Map<string, string>();
  edge?: EdgeAgent;
  started = 0;

  constructor(
    resources: Array<{ id: string; home: string }>,
    private readonly speedup = 600,
    private readonly clock: () => Millis = Date.now,
  ) {
    for (const r of resources) {
      this.ready.set(r.id, true);
      this.location.set(r.id, r.home);
    }
  }

  accepts(): boolean {
    return true;
  }

  status(resourceId: string): { ready: boolean; location: string } {
    return { ready: this.ready.get(resourceId) ?? false, location: this.location.get(resourceId) ?? "" };
  }

  start(spec: TaskSpec): void {
    this.started++;
    setTimeout(() => {
      if (spec.to) this.location.set(spec.resourceId, spec.to);
      this.edge?.finished(spec.resourceId, spec.taskId, true, this.clock());
    }, Math.max(5, spec.durationMs / this.speedup)).unref();
  }

  setReady(resourceId: string, ready: boolean): void {
    this.ready.set(resourceId, ready);
    if (!ready) this.edge?.resourceDown(resourceId, this.clock());
  }
}
