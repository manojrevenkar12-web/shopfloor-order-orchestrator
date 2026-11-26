import type { Capability, LocationId, Resource, Skill } from "./types.js";

/** Floor layout: named locations with coordinates in metres. Travel = Manhattan distance (aisles). */
export interface Layout {
  locations: Record<LocationId, { x: number; y: number }>;
}

export function distance(layout: Layout, a: LocationId, b: LocationId): number {
  const p = layout.locations[a];
  const q = layout.locations[b];
  if (!p || !q) throw new Error(`unknown location ${!p ? a : b}`);
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
}

export function capability(r: Resource, skill: Skill): Capability | undefined {
  return r.capabilities.find((c) => c.skill === skill);
}

/** A resource can take a task if it has every skill, each within its payload limit. */
export function canPerform(r: Resource, skills: Skill[], weightKg: number): boolean {
  return skills.every((s) => {
    const c = capability(r, s);
    return c !== undefined && (c.maxPayloadKg === undefined || weightKg <= c.maxPayloadKg);
  });
}

export function isMobile(r: Resource): boolean {
  return r.formFactor !== "stationary-cell";
}

/**
 * The reference shopfloor used by the lab and the demo service: a supermarket (WH), four robot
 * cells with different skill sets, an outbound area, six AMRs behind one VDA 5050 fleet bridge,
 * and a humanoid that can carry light loads and do slow pick-and-place.
 */
export function referenceShopfloor(): { layout: Layout; resources: Resource[] } {
  const layout: Layout = {
    locations: {
      WH: { x: 0, y: 0 },
      "WH-02": { x: 0, y: 30 },
      "C1-IN": { x: 40, y: 10 },
      "C2-IN": { x: 40, y: 30 },
      "C3-IN": { x: 70, y: 10 },
      "C4-IN": { x: 70, y: 30 },
      C1: { x: 45, y: 10 },
      C2: { x: 45, y: 30 },
      C3: { x: 75, y: 10 },
      C4: { x: 75, y: 30 },
      OUT: { x: 110, y: 20 },
      CHARGE: { x: 20, y: 45 },
    },
  };
  const cell = (id: string, skills: Skill[], edge: string): Resource => ({
    id,
    formFactor: "stationary-cell",
    edgeId: edge,
    home: id,
    capabilities: skills.map((skill) => ({ skill })),
  });
  const amr = (n: number): Resource => ({
    id: `amr-${n}`,
    formFactor: "amr",
    edgeId: "fleet-vda5050",
    home: "CHARGE",
    speedMps: 1.2,
    capabilities: [{ skill: "transport", maxPayloadKg: 600 }],
  });
  const resources: Resource[] = [
    cell("C1", ["pick-place", "screw"], "nova-c1"),
    cell("C2", ["pick-place", "screw", "inspect"], "nova-c2"),
    cell("C3", ["pick-place", "inspect", "pack"], "nova-c3"),
    cell("C4", ["pick-place", "screw", "inspect", "pack"], "nova-c4"),
    ...[1, 2, 3, 4, 5, 6].map(amr),
    {
      id: "humanoid-1",
      formFactor: "humanoid",
      edgeId: "nova-humanoid",
      home: "WH-02",
      speedMps: 0.8,
      capabilities: [
        { skill: "transport", maxPayloadKg: 12 },
        { skill: "pick-place", maxPayloadKg: 12, durationFactor: 2.2 },
        { skill: "pack", maxPayloadKg: 12, durationFactor: 2 },
      ],
    },
  ];
  return { layout, resources };
}
