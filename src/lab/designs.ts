import type { AllocationPolicy } from "../dispatch/allocator.js";
import type { OrchestratorConfig } from "../sync/cloud.js";
import { ROBUST_EDGE, type EdgeConfig } from "../sync/edge.js";

export interface Design {
  name: string;
  label: string;
  cloud: OrchestratorConfig;
  edge: EdgeConfig;
}

/** Fixed routes of a point-to-point integration: each product has its cell, each cell its AMR. */
export const STATIC_ROUTES: AllocationPolicy["staticRoutes"] = {
  cellForProduct: { "BRK-100": "C1", "BRK-220": "C2", "SNS-040": "C3", "KIT-300": "C3", "HSG-510": "C4" },
  amrForCell: { C1: "amr-1", C2: "amr-2", C3: "amr-3", C4: "amr-4" },
  transferAmrs: ["amr-5", "amr-6"],
};

const base: OrchestratorConfig = {
  policy: { capabilityRouting: true, queueDepth: 2, staticRoutes: STATIC_ROUTES },
  idempotentIntake: true,
  stableCommandIds: true,
  fencing: true,
  dispatchResendMs: 30_000,
  reassignSilentEdgeAfterMs: null,
  orderedEvents: true,
  reconcileOnReconnect: true,
  manualResetAfterMs: 2 * 3_600_000,
  erpIdempotencyKeys: true,
  edgeOfflineAfterMs: 45_000,
};

export const DESIGNS: Design[] = [
  {
    name: "point-to-point",
    label: "Status quo: point-to-point integration",
    cloud: {
      ...base,
      policy: { ...base.policy, capabilityRouting: false },
      idempotentIntake: false,
      stableCommandIds: false,
      fencing: false,
      orderedEvents: false,
      reconcileOnReconnect: false,
      erpIdempotencyKeys: false,
    },
    edge: { dedupeCommands: false, fencing: false, outbox: false, resendEveryMs: 10_000 },
  },
  {
    name: "cloud-only",
    label: "Cloud orchestrator, no edge buffering",
    cloud: { ...base, orderedEvents: false, reconcileOnReconnect: false, reassignSilentEdgeAfterMs: 120_000 },
    edge: { ...ROBUST_EDGE, outbox: false },
  },
  {
    name: "orchestrator",
    label: "Orchestrator: capability routing + edge outbox, fencing, reconcile",
    cloud: base,
    edge: ROBUST_EDGE,
  },
  {
    name: "orchestrator-static",
    label: "Ablation: orchestrator on fixed routes",
    cloud: { ...base, policy: { ...base.policy, capabilityRouting: false } },
    edge: ROBUST_EDGE,
  },
];

export function design(name: string): Design {
  const d = DESIGNS.find((x) => x.name === name);
  if (!d) throw new Error(`unknown design ${name}`);
  return d;
}
