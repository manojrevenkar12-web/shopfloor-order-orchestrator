import { canPerform, capability, distance, isMobile, type Layout } from "../domain/shopfloor.js";
import type { LocationId, Resource, Task } from "../domain/types.js";

export interface ResourceView {
  resource: Resource;
  /** Reachable and reporting ready. */
  available: boolean;
  location: LocationId;
  /** Tasks assigned to it and not yet done. */
  load: number;
  /** Estimated ms of work already queued on it. */
  backlogMs: number;
}

export interface AllocationPolicy {
  /** Choose by skills, payload, travel and backlog; false = fixed routes as configured in point-to-point integrations. */
  capabilityRouting: boolean;
  /** How many tasks a resource may hold at once (the edge keeps working these while offline). */
  queueDepth: number;
  /** Fixed routes used when capabilityRouting is false: product -> cell, cell -> AMR, transfer AMRs. */
  staticRoutes: { cellForProduct: Record<string, string>; amrForCell: Record<string, string>; transferAmrs: string[] };
}

export const inputBuffer = (cellId: string) => `${cellId}-IN`;

/** Duration on a given resource, including the skill's speed factor. */
export function durationOn(task: Task, r: Resource): number {
  const factor = Math.max(1, ...task.skills.map((s) => capability(r, s)?.durationFactor ?? 1));
  return Math.round(task.durationMs * factor);
}

/** Travel time for a mobile resource from where it is to the pickup and on to the drop. */
export function travelMs(layout: Layout, r: Resource, at: LocationId, from: LocationId, to: LocationId): number {
  const speed = r.speedMps ?? 1;
  return Math.round(((distance(layout, at, from) + distance(layout, from, to)) / speed) * 1000);
}

/** Pick a cell for a process task (called when its material supply is released). */
export function reserveCell(task: Task, views: ResourceView[], policy: AllocationPolicy): string | undefined {
  if (!policy.capabilityRouting) return policy.staticRoutes.cellForProduct[task.product];
  let best: { id: string; score: number } | undefined;
  for (const v of views) {
    if (isMobile(v.resource) && v.resource.formFactor !== "humanoid") continue;
    if (!v.available || !canPerform(v.resource, task.skills, task.weightKg)) continue;
    // Expected finish: queued work plus this job on that resource.
    const score = v.backlogMs + durationOn(task, v.resource);
    if (!best || score < best.score) best = { id: v.resource.id, score };
  }
  return best?.id;
}

/**
 * Choose a resource for each ready task, most urgent first. Process tasks go to the cell
 * reserved for them; transports go to the free mobile resource that gets there first.
 */
export function allocate(ready: Task[], views: ResourceView[], layout: Layout, policy: AllocationPolicy, dueOf: (t: Task) => number): Array<{ task: Task; resourceId: string }> {
  const out: Array<{ task: Task; resourceId: string }> = [];
  const byId = new Map(views.map((v) => [v.resource.id, { ...v }]));
  const sorted = [...ready].sort((a, b) => dueOf(a) - dueOf(b) || a.taskId.localeCompare(b.taskId));
  for (const t of sorted) {
    if (t.kind === "process") {
      const id = t.reservedFor;
      const v = id ? byId.get(id) : undefined;
      if (!v || !v.available || v.load >= policy.queueDepth) continue;
      out.push({ task: t, resourceId: v.resource.id });
      v.load++;
      v.backlogMs += durationOn(t, v.resource);
      continue;
    }
    if (!t.from || !t.to) continue; // not bound yet
    let chosen: (typeof views)[number] | undefined;
    if (!policy.capabilityRouting) {
      const cell = t.to.endsWith("-IN") ? t.to.slice(0, -3) : t.from;
      const fixed = policy.staticRoutes.amrForCell[cell];
      const candidates = fixed ? [fixed] : policy.staticRoutes.transferAmrs;
      chosen = candidates.map((c) => byId.get(c)).find((v) => v && v.available && v.load < policy.queueDepth);
    } else {
      let bestScore = Infinity;
      for (const v of byId.values()) {
        if (!isMobile(v.resource) || !v.available || v.load >= policy.queueDepth) continue;
        if (!canPerform(v.resource, t.skills, t.weightKg)) continue;
        const score = v.backlogMs + travelMs(layout, v.resource, v.location, t.from, t.to);
        if (score < bestScore) {
          bestScore = score;
          chosen = v;
        }
      }
    }
    if (!chosen) continue;
    out.push({ task: t, resourceId: chosen.resource.id });
    chosen.load++;
    chosen.backlogMs += travelMs(layout, chosen.resource, chosen.location, t.from, t.to) + t.durationMs;
  }
  return out;
}
