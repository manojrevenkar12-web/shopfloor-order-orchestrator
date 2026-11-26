import type { DesignResult, Results } from "./types";

/** Fixed order and colour per design: colour follows the design, never its rank. */
export const ORDER = ["point-to-point", "cloud-only", "orchestrator-static", "orchestrator"] as const;

export const color: Record<string, string> = {
  orchestrator: "var(--series-orchestrator)",
  "point-to-point": "var(--series-point-to-point)",
  "cloud-only": "var(--series-cloud-only)",
  "orchestrator-static": "var(--series-orchestrator-static)",
};

export const short: Record<string, string> = {
  "point-to-point": "Point-to-point (status quo)",
  "cloud-only": "Cloud-only orchestrator",
  "orchestrator-static": "Orchestrator, fixed routes",
  orchestrator: "Orchestrator",
};

export const ordered = (r: Results): DesignResult[] => ORDER.map((n) => r.designs.find((d) => d.design === n)).filter((d): d is DesignResult => !!d);
export const byName = (r: Results, n: string) => r.designs.find((d) => d.design === n);
