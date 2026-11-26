import type { OrderState, TaskState } from "./types.js";

export class IllegalTransition extends Error {
  constructor(what: string, from: string, to: string) {
    super(`${what}: ${from} -> ${to} is not allowed`);
  }
}

/**
 * The order lifecycle from the ERP order to the confirmation the ERP accepted.
 * COMPLETED means the shopfloor finished; CONFIRMED means the ERP booked it. Keeping the two
 * apart is what makes a lost confirmation visible instead of silently "done".
 */
const ORDER: Record<OrderState, OrderState[]> = {
  RECEIVED: ["PLANNED", "FAILED"],
  PLANNED: ["IN_PROGRESS", "ON_HOLD", "FAILED"],
  IN_PROGRESS: ["COMPLETED", "ON_HOLD", "FAILED"],
  ON_HOLD: ["IN_PROGRESS", "PLANNED", "FAILED"],
  COMPLETED: ["CONFIRMED"],
  CONFIRMED: [],
  FAILED: [],
};

/**
 * Task states. ASSIGNED = command sent, not yet acknowledged; ACCEPTED = the edge has it in its
 * local queue and may run it while offline. Only ASSIGNED work can be taken back without asking
 * the edge; ACCEPTED work is pinned to its edge until the edge reports or confirms a revoke.
 */
const TASK: Record<TaskState, TaskState[]> = {
  PENDING: ["READY"],
  // READY/FAILED -> DONE: a done report at the current epoch after a supervisor reset or a failure retry.
  // The work happened on the floor, so the cloud records it rather than waiting for a second run.
  READY: ["ASSIGNED", "DONE"],
  ASSIGNED: ["ACCEPTED", "READY", "RUNNING", "DONE", "FAILED"],
  ACCEPTED: ["RUNNING", "READY", "DONE", "FAILED"],
  RUNNING: ["DONE", "FAILED", "READY"],
  FAILED: ["READY", "DONE"],
  DONE: [],
};

export function canOrder(from: OrderState, to: OrderState): boolean {
  return from === to || ORDER[from].includes(to);
}

export function nextOrderState(from: OrderState, to: OrderState): OrderState {
  if (!canOrder(from, to)) throw new IllegalTransition("order", from, to);
  return to;
}

export function canTask(from: TaskState, to: TaskState): boolean {
  return from === to || TASK[from].includes(to);
}

export function nextTaskState(from: TaskState, to: TaskState): TaskState {
  if (!canTask(from, to)) throw new IllegalTransition("task", from, to);
  return to;
}

export const TERMINAL_TASK: ReadonlySet<TaskState> = new Set(["DONE"]);
