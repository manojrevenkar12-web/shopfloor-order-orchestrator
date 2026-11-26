import { describe, expect, it } from "vitest";
import { design } from "../src/lab/designs.js";
import { order, rig, T0 } from "./helpers.js";

const platform = design("orchestrator");
const cloudOnly = design("cloud-only");
const p2p = design("point-to-point");

describe("orchestrator end to end (simulated network)", () => {
  it("takes a production order from intake to ERP confirmation", () => {
    const r = rig(platform.cloud, platform.edge);
    r.cloud.intake(order(), T0);
    r.until(2 * 3_600_000);
    const rec = r.cloud.orders.get("MES-1")!;
    expect(rec.state).toBe("CONFIRMED");
    expect(r.erp.bookings.get("MES-1")).toHaveLength(1);
    const tasks = rec.taskIds.map((id) => r.cloud.tasks.get(id)!);
    expect(tasks.map((t) => t.state)).toEqual(["DONE", "DONE", "DONE"]);
    // supply went to the reserved cell's input buffer, output left from that cell
    const cell = tasks[1]!.reservedFor!;
    expect(tasks[0]!.to).toBe(`${cell}-IN`);
    expect(tasks[2]!.from).toBe(cell);
  });

  it("recognises an order the ERP sent twice", () => {
    const r = rig(platform.cloud, platform.edge);
    r.cloud.intake(order(), T0);
    r.cloud.intake(order(), T0 + 60_000);
    r.until(2 * 3_600_000);
    expect(r.cloud.orders.size).toBe(1);
    expect(r.truth.duplicateExecutions).toBe(0);
  });

  it("point-to-point turns the same re-send into a second production run", () => {
    const r = rig(p2p.cloud, p2p.edge);
    r.cloud.intake(order(), T0);
    r.cloud.intake(order(), T0 + 60_000);
    r.until(3 * 3_600_000);
    expect(r.cloud.orders.size).toBe(2);
    expect(r.truth.duplicateExecutions).toBe(3);
    expect(r.erp.bookings.get("MES-1")).toHaveLength(2);
  });

  it("applies events exactly once and in order on a lossy, duplicating network", () => {
    const r = rig(platform.cloud, platform.edge, { lossRate: 0.05, duplicateRate: 0.1, latencyMs: [10, 900] }, 7);
    for (let i = 0; i < 20; i++) r.cloud.intake(order({ orderId: `EWM-${i}`, kind: "transfer", from: "WH", to: "C3-IN", weightKg: 80, receivedAt: T0 }), T0);
    r.until(3 * 3_600_000);
    expect([...r.cloud.orders.values()].every((o) => o.state === "CONFIRMED")).toBe(true);
    expect(r.truth.duplicateExecutions).toBe(0);
    expect(r.cloud.stats.duplicateEventsIgnored).toBeGreaterThan(0);
  });

  it("keeps work pinned to a cut-off edge, which finishes it offline and reports on reconnect", () => {
    const r = rig(platform.cloud, platform.edge);
    for (let i = 0; i < 6; i++) r.cloud.intake(order({ orderId: `EWM-${i}`, kind: "transfer", from: "WH", to: "OUT", weightKg: 80 }), T0);
    r.engine.at(T0 + 30_000, () => r.network.setCut("fleet-vda5050", true));
    r.engine.at(T0 + 25 * 60_000, () => r.network.setCut("fleet-vda5050", false));
    r.until(90 * 60_000);
    expect(r.truth.duplicateExecutions).toBe(0);
    expect(r.cloud.stats.reconciles).toBeGreaterThan(0);
    expect([...r.cloud.orders.values()].every((o) => o.state === "CONFIRMED")).toBe(true);
    expect(r.cloud.stats.manualResets).toBe(0);
  });

  it("a cloud-only orchestrator reassigns that work and the shopfloor does it twice", () => {
    const r = rig(cloudOnly.cloud, cloudOnly.edge);
    for (let i = 0; i < 6; i++) r.cloud.intake(order({ orderId: `EWM-${i}`, kind: "transfer", from: "WH", to: "OUT", weightKg: 8 }), T0);
    r.engine.at(T0 + 30_000, () => r.network.setCut("fleet-vda5050", true));
    r.engine.at(T0 + 25 * 60_000, () => r.network.setCut("fleet-vda5050", false));
    r.until(4 * 3_600_000);
    expect(r.cloud.stats.reassignedFromSilentEdges).toBeGreaterThan(0);
    expect(r.truth.duplicateExecutions).toBeGreaterThan(0);
  });

  it("re-plans around a broken AMR: its queued work comes back and goes to another", () => {
    const r = rig(platform.cloud, platform.edge);
    for (let i = 0; i < 4; i++) r.cloud.intake(order({ orderId: `EWM-${i}`, kind: "transfer", from: "WH", to: "C1-IN", weightKg: 200 }), T0);
    r.engine.at(T0 + 20_000, () => {
      for (let n = 1; n <= 6; n++) if (n !== 4) r.drivers.get(`amr-${n}`)!.breakdown(`amr-${n}`, T0 + 10 * 3_600_000);
    });
    r.until(3 * 3_600_000);
    expect([...r.cloud.orders.values()].every((o) => o.state === "CONFIRMED")).toBe(true);
    const assignees = new Set([...r.cloud.tasks.values()].map((t) => t.assignee));
    expect(assignees).toEqual(new Set(["amr-4"]));
  });
});
