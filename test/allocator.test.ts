import { describe, expect, it } from "vitest";
import { allocate, reserveCell, type AllocationPolicy, type ResourceView } from "../src/dispatch/allocator.js";
import { referenceShopfloor } from "../src/domain/shopfloor.js";
import type { Task } from "../src/domain/types.js";
import { STATIC_ROUTES } from "../src/lab/designs.js";
import { decompose } from "../src/planner/decompose.js";
import { order } from "./helpers.js";

const { layout, resources } = referenceShopfloor();
const policy: AllocationPolicy = { capabilityRouting: true, queueDepth: 2, staticRoutes: STATIC_ROUTES };
const views = (over: Record<string, Partial<ResourceView>> = {}): ResourceView[] =>
  resources.map((r) => ({ resource: r, available: true, location: r.home, load: 0, backlogMs: 0, ...over[r.id] }));
const process = (product: string, qty = 10): Task => decompose(order({ product, quantity: qty }))[1]!;

describe("cell reservation", () => {
  it("picks a cell with every skill and the least queued work", () => {
    const t = process("BRK-220");
    expect(reserveCell(t, views(), policy)).toBe("C2");
    expect(reserveCell(t, views({ C2: { backlogMs: 3_600_000 } }), policy)).toBe("C4");
    expect(reserveCell(t, views({ C2: { available: false }, C4: { available: false } }), policy)).toBeUndefined();
  });

  it("can give light work to the humanoid when it finishes first, never heavy work", () => {
    const light = process("KIT-300", 8); // 7.2 kg
    expect(reserveCell(light, views({ C3: { backlogMs: 9e6 }, C4: { backlogMs: 9e6 } }), policy)).toBe("humanoid-1");
    const heavy = process("KIT-300", 40); // 36 kg
    expect(reserveCell(heavy, views({ C3: { backlogMs: 9e6 }, C4: { backlogMs: 9e6 } }), policy)).toBe("C3");
  });

  it("uses the fixed route when capability routing is off", () => {
    expect(reserveCell(process("BRK-220"), views({ C2: { backlogMs: 9e6 } }), { ...policy, capabilityRouting: false })).toBe("C2");
  });
});

describe("allocation", () => {
  const transport = (id: string, from: string, to: string, kg = 50): Task => ({ ...decompose(order({ orderId: id, kind: "transfer", from, to, weightKg: kg }))[0]!, state: "READY" });

  it("sends a transport to the resource that gets there first", () => {
    const v = views({ "amr-3": { location: "WH" } });
    const [a] = allocate([transport("EWM-1", "WH", "C1-IN")], v, layout, policy, () => 0);
    expect(a!.resourceId).toBe("amr-3");
  });

  it("respects queue depth and payload", () => {
    const v = views(Object.fromEntries(resources.filter((r) => r.formFactor === "amr").map((r) => [r.id, { load: 2 }])));
    expect(allocate([transport("EWM-1", "WH", "C1-IN", 300)], v, layout, policy, () => 0)).toHaveLength(0);
    const [a] = allocate([transport("EWM-2", "WH", "C1-IN", 8)], v, layout, policy, () => 0);
    expect(a!.resourceId).toBe("humanoid-1");
  });

  it("serves the earliest due date first when resources are short", () => {
    const v = views(Object.fromEntries(resources.filter((r) => r.id !== "amr-1" && r.formFactor !== "stationary-cell").map((r) => [r.id, { available: false }])));
    const late = transport("EWM-LATE", "WH", "C1-IN");
    const urgent = transport("EWM-URGENT", "WH", "C2-IN");
    const due: Record<string, number> = { "EWM-LATE": 2, "EWM-URGENT": 1 };
    const out = allocate([late, urgent], v.map((x) => (x.resource.id === "amr-1" ? { ...x, load: 1 } : x)), layout, policy, (t) => due[t.orderId]!);
    expect(out.map((o) => o.task.orderId)).toEqual(["EWM-URGENT"]);
  });
});
