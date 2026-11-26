import { z } from "zod";
import type { LocationId, Order } from "../domain/types.js";
import { RECIPES } from "../planner/recipes.js";

/**
 * A warehouse task as SAP EWM exposes it over OData (field names modelled on the warehouse
 * order/task API). Storage bins are mapped to shopfloor locations by configuration.
 */
export const EwmWarehouseTask = z.object({
  EWMWarehouse: z.string().min(1),
  WarehouseOrder: z.string().optional(),
  WarehouseTask: z.string().min(1),
  WarehouseTaskItem: z.string().default("0001"),
  WarehouseProcessType: z.string().optional(),
  Product: z.string().min(1),
  SourceStorageBin: z.string().min(1),
  DestinationStorageBin: z.string().min(1),
  TargetQuantityInBaseUnit: z.coerce.number().positive(),
  BaseUnit: z.string().default("EA"),
  NetWeight: z.coerce.number().nonnegative().default(0),
  WeightUnit: z.enum(["KG", "G"]).default("KG"),
  WhseTaskPlannedClosingDateTime: z.string().datetime({ offset: true }).optional(),
});
export type EwmWarehouseTask = z.infer<typeof EwmWarehouseTask>;

/** A production request from the MES, shaped after ISA-95 / B2MML production requests. */
export const MesProductionRequest = z.object({
  ID: z.string().min(1),
  MaterialDefinitionID: z.string().min(1),
  Quantity: z.object({ QuantityString: z.coerce.number().int().positive(), UnitOfMeasure: z.string().default("EA") }),
  EarliestStartTime: z.string().datetime({ offset: true }).optional(),
  RequestedEndTime: z.string().datetime({ offset: true }),
  SourceEquipmentID: z.string().default("WH"),
  DestinationEquipmentID: z.string().default("OUT"),
});
export type MesProductionRequest = z.infer<typeof MesProductionRequest>;

export interface BinMap {
  /** Storage bin -> shopfloor location; prefixes allowed with a trailing '*'. */
  [bin: string]: LocationId;
}

export class UnmappedBin extends Error {}

export function locate(bins: BinMap, bin: string): LocationId {
  if (bins[bin]) return bins[bin]!;
  for (const [k, v] of Object.entries(bins)) if (k.endsWith("*") && bin.startsWith(k.slice(0, -1))) return v;
  throw new UnmappedBin(`storage bin ${bin} has no shopfloor location`);
}

/** EWM warehouse task -> transfer order. The order id is the business key EWM confirms against. */
export function fromEwm(input: unknown, bins: BinMap, receivedAt: number): Order {
  const t = EwmWarehouseTask.parse(input);
  const weight = t.WeightUnit === "G" ? t.NetWeight / 1000 : t.NetWeight;
  return {
    orderId: `EWM-${t.EWMWarehouse}-${t.WarehouseTask}-${t.WarehouseTaskItem}`,
    source: "EWM",
    kind: "transfer",
    product: t.Product,
    quantity: t.TargetQuantityInBaseUnit,
    weightKg: weight,
    from: locate(bins, t.SourceStorageBin),
    to: locate(bins, t.DestinationStorageBin),
    dueAt: t.WhseTaskPlannedClosingDateTime ? Date.parse(t.WhseTaskPlannedClosingDateTime) : receivedAt + 90 * 60_000,
    receivedAt,
  };
}

/** MES production request -> production order. Unknown products are rejected at the door. */
export function fromMes(input: unknown, receivedAt: number): Order {
  const r = MesProductionRequest.parse(input);
  const recipe = RECIPES[r.MaterialDefinitionID];
  if (!recipe) throw new Error(`no recipe for material ${r.MaterialDefinitionID}`);
  return {
    orderId: `MES-${r.ID}`,
    source: "MES",
    kind: "production",
    product: r.MaterialDefinitionID,
    quantity: r.Quantity.QuantityString,
    weightKg: recipe.unitWeightKg * r.Quantity.QuantityString,
    from: r.SourceEquipmentID,
    to: r.DestinationEquipmentID,
    dueAt: Date.parse(r.RequestedEndTime),
    receivedAt,
  };
}

/** The confirmation call back to the ERP, with the idempotency key that makes retries safe. */
export interface ConfirmationRequest {
  method: "POST";
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function confirmationFor(order: Order, completedAt: number): ConfirmationRequest {
  const key = `confirm:${order.orderId}`;
  if (order.source === "EWM") {
    const [, warehouse, task, item] = order.orderId.split("-");
    return {
      method: "POST",
      path: "/WarehouseTask/ConfirmWarehouseTaskExact",
      headers: { "Idempotency-Key": key, "Content-Type": "application/json" },
      body: { EWMWarehouse: warehouse, WarehouseTask: task, WarehouseTaskItem: item, ActualQuantityInBaseUnit: order.quantity, ConfirmedAt: new Date(completedAt).toISOString() },
    };
  }
  return {
    method: "POST",
    path: "/ProductionResponse",
    headers: { "Idempotency-Key": key, "Content-Type": "application/json" },
    body: { ProductionRequestID: order.orderId.replace(/^MES-/, ""), ResponseState: "Completed", ActualQuantity: order.quantity, EndTime: new Date(completedAt).toISOString() },
  };
}
