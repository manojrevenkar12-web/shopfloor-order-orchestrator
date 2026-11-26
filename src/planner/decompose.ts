import type { Order, Task } from "../domain/types.js";
import { recipeFor } from "./recipes.js";

/** Handling time at each end of a transport (dock, pick, drop), ms. */
export const HANDLING_MS = 45_000;

function task(order: Order, seq: number, t: Omit<Task, "taskId" | "orderId" | "seq" | "state" | "epoch" | "attempts" | "product" | "quantity">): Task {
  return { taskId: `${order.orderId}/${seq}`, orderId: order.orderId, seq, product: order.product, quantity: order.quantity, state: "PENDING", epoch: 0, attempts: 0, ...t };
}

/**
 * Turns one business order into tasks with dependencies. The tasks ask for skills, not robots,
 * and leave the cell open: the material supply goes "to wherever the process task ends up",
 * resolved at dispatch (late binding), so the allocator can pick the best cell at that moment.
 *
 * - transfer (EWM warehouse task): one transport, from the source bin to the destination bin.
 * - production (MES order): supply transport -> process at a cell -> output transport.
 */
export function decompose(order: Order): Task[] {
  if (order.kind === "transfer") {
    return [
      task(order, 1, { kind: "transport", skills: ["transport"], weightKg: order.weightKg, durationMs: 2 * HANDLING_MS, from: order.from, to: order.to, dependsOn: [] }),
    ];
  }
  const recipe = recipeFor(order.product);
  const processMs = Math.round((recipe.setupMinutes + recipe.minutesPerUnit * order.quantity) * 60_000);
  const weight = recipe.unitWeightKg * order.quantity;
  const supply = task(order, 1, {
    kind: "transport",
    skills: ["transport"],
    weightKg: weight,
    durationMs: 2 * HANDLING_MS,
    from: order.from,
    bindToOf: { taskId: `${order.orderId}/2`, end: "to" },
    dependsOn: [],
  });
  const process = task(order, 2, { kind: "process", skills: recipe.skills, weightKg: weight, durationMs: processMs, dependsOn: [] });
  const output = task(order, 3, {
    kind: "transport",
    skills: ["transport"],
    weightKg: weight,
    durationMs: 2 * HANDLING_MS,
    to: order.to,
    bindToOf: { taskId: `${order.orderId}/2`, end: "from" },
    dependsOn: [process.taskId],
  });
  // The process may start once its material is at the cell.
  process.dependsOn = [supply.taskId];
  // The supply only leaves once the process has a reserved cell; the allocator reserves one first.
  return [supply, process, output];
}
