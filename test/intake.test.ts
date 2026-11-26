import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { confirmationFor, fromEwm, fromMes, UnmappedBin } from "../src/intake/adapters.js";
import { DEFAULT_BINS } from "../src/service/config.js";

const T = Date.UTC(2026, 10, 26, 8);
const ewm = { EWMWarehouse: "1710", WarehouseOrder: "2000041", WarehouseTask: "100000812", WarehouseTaskItem: "0001", Product: "HU-4711", SourceStorageBin: "SM-01-03-B", DestinationStorageBin: "LINE-C2-IN", TargetQuantityInBaseUnit: "1", NetWeight: 182.5, WeightUnit: "KG" };

describe("SAP EWM intake", () => {
  it("maps a warehouse task to a transfer order with its business key", () => {
    const o = fromEwm(ewm, DEFAULT_BINS, T);
    expect(o).toMatchObject({ orderId: "EWM-1710-100000812-0001", kind: "transfer", from: "WH", to: "C2-IN", weightKg: 182.5, quantity: 1, dueAt: T + 90 * 60_000 });
  });

  it("converts grams and honours the planned closing time", () => {
    const o = fromEwm({ ...ewm, NetWeight: 2500, WeightUnit: "G", WhseTaskPlannedClosingDateTime: "2026-11-26T09:15:00+01:00" }, DEFAULT_BINS, T);
    expect(o.weightKg).toBe(2.5);
    expect(o.dueAt).toBe(Date.parse("2026-11-26T08:15:00Z"));
  });

  it("rejects an unknown bin and a malformed task", () => {
    expect(() => fromEwm({ ...ewm, DestinationStorageBin: "NOWHERE" }, DEFAULT_BINS, T)).toThrow(UnmappedBin);
    expect(() => fromEwm({ ...ewm, TargetQuantityInBaseUnit: 0 }, DEFAULT_BINS, T)).toThrow(ZodError);
  });
});

describe("MES intake", () => {
  const req = { ID: "PR-88231", MaterialDefinitionID: "HSG-510", Quantity: { QuantityString: "24" }, RequestedEndTime: "2026-11-26T14:00:00Z" };

  it("maps a production request and computes the weight from the recipe", () => {
    const o = fromMes(req, T);
    expect(o).toMatchObject({ orderId: "MES-PR-88231", kind: "production", quantity: 24, from: "WH", to: "OUT" });
    expect(o.weightKg).toBeCloseTo(3.1 * 24);
  });

  it("refuses a material without a recipe", () => {
    expect(() => fromMes({ ...req, MaterialDefinitionID: "XYZ" }, T)).toThrow(/no recipe/);
  });
});

describe("confirmations", () => {
  it("confirm EWM tasks exactly, with an idempotency key", () => {
    const c = confirmationFor(fromEwm(ewm, DEFAULT_BINS, T), T + 600_000);
    expect(c.path).toBe("/WarehouseTask/ConfirmWarehouseTaskExact");
    expect(c.headers["Idempotency-Key"]).toBe("confirm:EWM-1710-100000812-0001");
    expect(c.body).toMatchObject({ EWMWarehouse: "1710", WarehouseTask: "100000812", WarehouseTaskItem: "0001", ActualQuantityInBaseUnit: 1 });
  });
});
