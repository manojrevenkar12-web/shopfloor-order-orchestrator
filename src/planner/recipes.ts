import type { Skill } from "../domain/types.js";

/** What making one batch of a product takes: the skills, minutes per unit, and set-up minutes. */
export interface Recipe {
  product: string;
  skills: Skill[];
  minutesPerUnit: number;
  setupMinutes: number;
  unitWeightKg: number;
}

export const RECIPES: Record<string, Recipe> = {
  "BRK-100": { product: "BRK-100", skills: ["pick-place", "screw"], minutesPerUnit: 0.9, setupMinutes: 3, unitWeightKg: 1.8 },
  "BRK-220": { product: "BRK-220", skills: ["pick-place", "screw", "inspect"], minutesPerUnit: 1.3, setupMinutes: 4, unitWeightKg: 2.4 },
  "SNS-040": { product: "SNS-040", skills: ["pick-place", "inspect"], minutesPerUnit: 0.6, setupMinutes: 2, unitWeightKg: 0.3 },
  "KIT-300": { product: "KIT-300", skills: ["pick-place", "pack"], minutesPerUnit: 0.8, setupMinutes: 2, unitWeightKg: 0.9 },
  "HSG-510": { product: "HSG-510", skills: ["pick-place", "screw", "inspect", "pack"], minutesPerUnit: 1.6, setupMinutes: 5, unitWeightKg: 3.1 },
};

export function recipeFor(product: string): Recipe {
  const r = RECIPES[product];
  if (!r) throw new Error(`no recipe for product ${product}`);
  return r;
}
