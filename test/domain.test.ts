import { describe, expect, it } from "vitest";
import { IllegalTransition, nextOrderState, nextTaskState } from "../src/domain/lifecycle.js";
import { canPerform, referenceShopfloor } from "../src/domain/shopfloor.js";
import { decompose } from "../src/planner/decompose.js";
import { order } from "./helpers.js";

describe("order and task lifecycle", () => {
  it("separates finished on the floor from booked in the ERP", () => {
    expect(nextOrderState("IN_PROGRESS", "COMPLETED")).toBe("COMPLETED");
    expect(() => nextOrderState("IN_PROGRESS", "CONFIRMED")).toThrow(IllegalTransition);
    expect(() => nextOrderState("CONFIRMED", "IN_PROGRESS")).toThrow(IllegalTransition);
  });

  it("lets only un-started work go back to READY without the edge, and DONE is final", () => {
    expect(nextTaskState("ASSIGNED", "READY")).toBe("READY");
    expect(nextTaskState("RUNNING", "DONE")).toBe("DONE");
    expect(() => nextTaskState("DONE", "READY")).toThrow(IllegalTransition);
    expect(() => nextTaskState("PENDING", "ASSIGNED")).toThrow(IllegalTransition);
  });
});

describe("decomposition", () => {
  it("turns a warehouse task into one transport", () => {
    const tasks = decompose(order({ orderId: "EWM-1", kind: "transfer", from: "WH", to: "C2-IN", weightKg: 200 }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: "EWM-1/1", kind: "transport", from: "WH", to: "C2-IN", skills: ["transport"] });
  });

  it("turns a production order into supply, process and output, with late-bound cell", () => {
    const [supply, process, output] = decompose(order({ product: "BRK-220", quantity: 20 }));
    expect(supply!.bindToOf).toEqual({ taskId: "MES-1/2", end: "to" });
    expect(supply!.to).toBeUndefined();
    expect(process!.skills).toEqual(["pick-place", "screw", "inspect"]);
    expect(process!.dependsOn).toEqual(["MES-1/1"]);
    expect(output!.dependsOn).toEqual(["MES-1/2"]);
    expect(process!.durationMs).toBe(Math.round((4 + 1.3 * 20) * 60_000));
  });

  it("gives the same ids when the same order is planned twice", () => {
    expect(decompose(order()).map((t) => t.taskId)).toEqual(decompose(order()).map((t) => t.taskId));
  });
});

describe("capabilities", () => {
  const { resources } = referenceShopfloor();
  const get = (id: string) => resources.find((r) => r.id === id)!;

  it("matches on skills and payload, not on robot type", () => {
    expect(canPerform(get("C4"), ["pick-place", "screw", "inspect", "pack"], 100)).toBe(true);
    expect(canPerform(get("C1"), ["inspect"], 1)).toBe(false);
    expect(canPerform(get("humanoid-1"), ["transport"], 10)).toBe(true);
    expect(canPerform(get("humanoid-1"), ["transport"], 40)).toBe(false);
    expect(canPerform(get("amr-1"), ["transport"], 450)).toBe(true);
  });
});
