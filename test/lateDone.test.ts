import { describe, expect, it } from "vitest";
import { referenceShopfloor } from "../src/domain/shopfloor.js";
import { Rng } from "../src/lab/engine.js";
import { design } from "../src/lab/designs.js";
import { SimErp } from "../src/lab/simErp.js";
import { Orchestrator } from "../src/sync/cloud.js";
import type { CloudSide, Command, EdgeMessage } from "../src/sync/protocol.js";
import { order, T0 } from "./helpers.js";

/** A link we drive by hand, so the order of events is exactly the one under test. */
function handLink() {
  const sent: Array<{ edgeId: string; cmd: Command }> = [];
  let deliver: (m: EdgeMessage) => void = () => {};
  const link: CloudSide = { send: (edgeId, cmd) => sent.push({ edgeId, cmd }), onMessage: (h) => (deliver = h) };
  return { link, sent, deliver: (m: EdgeMessage) => deliver(m) };
}

describe("a done report that arrives after a supervisor reset", () => {
  for (const name of ["cloud-only", "point-to-point", "orchestrator"] as const) {
    it(`${name}: the task is recorded DONE and stays tracked until then`, () => {
      const { layout, resources } = referenceShopfloor();
      const cfg = { ...design(name).cloud, manualResetAfterMs: 60_000 };
      let now = T0;
      const h = handLink();
      const cloud = new Orchestrator(resources, layout, h.link, new SimErp(new Rng(1)), cfg, () => now);
      const fleet = resources.filter((r) => r.edgeId === "fleet-vda5050");
      const hb = (seq: number): EdgeMessage => ({ type: "heartbeat", edgeId: "fleet-vda5050", at: now, lastSeq: seq, resources: fleet.map((r) => ({ id: r.id, ready: true, location: r.home, queued: 0 })) });
      h.deliver(hb(0));
      cloud.intake(order({ orderId: "EWM-1", kind: "transfer", from: "WH", to: "OUT", weightKg: 80 }), now);
      cloud.tick(now);
      const t = cloud.tasks.get("EWM-1/1")!;
      expect(t.state).toBe("ASSIGNED");
      const epoch = t.epoch;
      const resourceId = t.assignee!;
      const ev = (seq: number, kind: "accepted" | "done"): EdgeMessage => ({ type: "event", edgeId: "fleet-vda5050", seq, taskId: t.taskId, epoch, kind, resourceId, at: now });
      h.deliver(ev(1, "accepted"));
      // Nothing heard for longer than the supervisor waits: the task is reset to READY.
      now += 120_000;
      cloud.tick(now);
      expect(cloud.stats.manualResets).toBe(1);
      // The original run finishes and its report arrives before the task is dispatched again.
      h.deliver(ev(2, "done"));
      expect(t.state).toBe("DONE");
      expect(cloud.activeTasks).toBe(0);
      expect(cloud.orders.get("EWM-1")!.state).not.toBe("IN_PROGRESS");
    });
  }

  it("never drops a task from the active set while it is not DONE", () => {
    const { layout, resources } = referenceShopfloor();
    const h = handLink();
    const cloud = new Orchestrator(resources, layout, h.link, new SimErp(new Rng(1)), design("cloud-only").cloud, () => T0);
    cloud.intake(order(), T0);
    // A done report for a task that was never dispatched (PENDING) is not a legal move; it must not orphan the task.
    h.deliver({ type: "event", edgeId: "nova-c1", seq: 1, taskId: "MES-1/2", epoch: 0, kind: "done", resourceId: "C1", at: T0 });
    expect(cloud.tasks.get("MES-1/2")!.state).toBe("PENDING");
    expect(cloud.activeTasks).toBe(3);
  });
});
