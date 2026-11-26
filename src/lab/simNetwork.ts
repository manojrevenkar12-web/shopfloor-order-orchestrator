import type { CloudSide, Command, EdgeMessage, EdgeSide } from "../sync/protocol.js";
import type { Engine, Rng } from "./engine.js";

export interface NetworkParams {
  latencyMs: [number, number];
  lossRate: number;
  duplicateRate: number;
}

export const DEFAULT_NETWORK: NetworkParams = { latencyMs: [30, 120], lossRate: 0.003, duplicateRate: 0.003 };

/**
 * The cloud-edge network: per-message latency, loss and duplication (what an at-least-once
 * broker redelivery looks like to the application), and partitions per edge. A message is lost
 * if its edge is cut off when it is sent or when it would arrive.
 */
export class SimNetwork {
  private readonly toEdge = new Map<string, (cmd: Command) => void>();
  private toCloud: (msg: EdgeMessage) => void = () => {};
  private readonly cut = new Set<string>();
  private cloudCut = false;
  sent = 0;
  lost = 0;
  bytes = 0;

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly params: NetworkParams = DEFAULT_NETWORK,
  ) {}

  setCut(edgeId: string, cut: boolean): void {
    if (cut) this.cut.add(edgeId);
    else this.cut.delete(edgeId);
  }

  setCloudCut(cut: boolean): void {
    this.cloudCut = cut;
  }

  private down(edgeId: string): boolean {
    return this.cloudCut || this.cut.has(edgeId);
  }

  private deliver(edgeId: string, size: number, fn: () => void): void {
    this.sent++;
    this.bytes += size;
    if (this.down(edgeId) || this.rng.chance(this.params.lossRate)) {
      this.lost++;
      return;
    }
    const copies = this.rng.chance(this.params.duplicateRate) ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const [lo, hi] = this.params.latencyMs;
      this.engine.after(lo + this.rng.next() * (hi - lo) + i * 400, () => {
        if (this.down(edgeId)) {
          this.lost++;
          return;
        }
        fn();
      });
    }
  }

  cloud(): CloudSide {
    return {
      send: (edgeId, cmd) => this.deliver(edgeId, approxSize(cmd), () => this.toEdge.get(edgeId)?.(cmd)),
      onMessage: (h) => {
        this.toCloud = h;
      },
    };
  }

  edge(edgeId: string): EdgeSide {
    return {
      send: (msg) => this.deliver(edgeId, approxSize(msg), () => this.toCloud(msg)),
      onCommand: (h) => {
        this.toEdge.set(edgeId, h);
      },
    };
  }
}

function approxSize(m: Command | EdgeMessage): number {
  switch (m.type) {
    case "dispatch":
      return 420;
    case "heartbeat":
      return 120 + 90 * m.resources.length;
    case "reconcile":
      return 80 + 60 * m.held.length;
    case "event":
      return 210;
    default:
      return 60;
  }
}
