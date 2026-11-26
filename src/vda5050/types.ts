/**
 * VDA 5050 v2 message shapes (the subset an orchestrator needs). Topics follow the standard:
 * `<interfaceName>/<majorVersion>/<manufacturer>/<serialNumber>/<topic>`, e.g. `uagv/v2/acme/amr-1/order`.
 */
export type BlockingType = "NONE" | "SOFT" | "HARD";
export type ActionStatus = "WAITING" | "INITIALIZING" | "RUNNING" | "PAUSED" | "FINISHED" | "FAILED";
export type OperatingMode = "AUTOMATIC" | "SEMIAUTOMATIC" | "MANUAL" | "SERVICE" | "TEACHIN";

export interface Header {
  headerId: number;
  timestamp: string;
  version: string;
  manufacturer: string;
  serialNumber: string;
}

export interface Action {
  actionType: string;
  actionId: string;
  blockingType: BlockingType;
  actionParameters?: Array<{ key: string; value: string | number | boolean }>;
}

export interface Node {
  nodeId: string;
  sequenceId: number;
  released: boolean;
  nodePosition?: { x: number; y: number; mapId: string };
  actions: Action[];
}

export interface Edge {
  edgeId: string;
  sequenceId: number;
  released: boolean;
  startNodeId: string;
  endNodeId: string;
  actions: Action[];
}

export interface OrderMessage extends Header {
  orderId: string;
  orderUpdateId: number;
  nodes: Node[];
  edges: Edge[];
}

export interface StateMessage extends Header {
  orderId: string;
  orderUpdateId: number;
  lastNodeId: string;
  lastNodeSequenceId: number;
  driving: boolean;
  operatingMode: OperatingMode;
  nodeStates: Array<{ nodeId: string; sequenceId: number; released: boolean }>;
  edgeStates: Array<{ edgeId: string; sequenceId: number; released: boolean }>;
  actionStates: Array<{ actionId: string; actionType?: string; actionStatus: ActionStatus; resultDescription?: string }>;
  errors: Array<{ errorType: string; errorLevel: "WARNING" | "FATAL"; errorDescription?: string }>;
  batteryState?: { batteryCharge: number; charging: boolean };
}
