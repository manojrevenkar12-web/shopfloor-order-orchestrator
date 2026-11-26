/** Time is epoch milliseconds everywhere inside the core; ISO strings only at the edges (ERP, APIs). */
export type Millis = number;
export type LocationId = string;

/**
 * What a resource can do. Skills are the contract between orders and robots: a planner asks for
 * skills, never for a robot type, so a new form factor plugs in by declaring the skills it has.
 */
export type Skill = "transport" | "pick-place" | "screw" | "inspect" | "pack";

export type FormFactor = "stationary-cell" | "amr" | "agv" | "humanoid";

export interface Capability {
  skill: Skill;
  /** Heaviest load this resource handles for this skill, kg. Absent = no limit. */
  maxPayloadKg?: number;
  /** Multiplies the nominal duration (a humanoid assembles more slowly than a cell). */
  durationFactor?: number;
}

export interface Resource {
  id: string;
  formFactor: FormFactor;
  /** The edge gateway (a NOVA OS instance or a fleet bridge) that commands this resource. */
  edgeId: string;
  capabilities: Capability[];
  /** Where a stationary resource is, or where a mobile one parks. */
  home: LocationId;
  /** Travel speed for mobile resources, metres per second. */
  speedMps?: number;
}

export type OrderSource = "EWM" | "MES";
export type OrderKind = "production" | "transfer";

/** A business order as it arrives from SAP EWM (warehouse task) or the MES (production order). */
export interface Order {
  orderId: string;
  source: OrderSource;
  kind: OrderKind;
  product: string;
  quantity: number;
  weightKg: number;
  from: LocationId;
  to: LocationId;
  dueAt: Millis;
  receivedAt: Millis;
}

export type OrderState = "RECEIVED" | "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CONFIRMED" | "ON_HOLD" | "FAILED";

export type TaskKind = "process" | "transport";

export type TaskState = "PENDING" | "READY" | "ASSIGNED" | "ACCEPTED" | "RUNNING" | "DONE" | "FAILED";

export interface Task {
  /** Deterministic: `${orderId}/${seq}`, so re-planning the same order never creates new ids. */
  taskId: string;
  orderId: string;
  seq: number;
  kind: TaskKind;
  skills: Skill[];
  product: string;
  quantity: number;
  weightKg: number;
  /** Nominal execution time without travel, ms. */
  durationMs: number;
  from?: LocationId;
  to?: LocationId;
  /**
   * Late binding for transports around a process step: the cell is chosen when the material
   * supply becomes ready, then the supply goes to that cell's input buffer and the output
   * transport starts at the cell.
   */
  bindToOf?: { taskId: string; end: "from" | "to" };
  /** For a process task: the cell reserved for it when its material supply was released. */
  reservedFor?: string;
  dependsOn: string[];
  state: TaskState;
  assignee?: string;
  /** Fencing token: raised on every (re)assignment. An edge drops commands and reports with an older epoch. */
  epoch: number;
  attempts: number;
  assignedAt?: Millis;
  doneAt?: Millis;
}
