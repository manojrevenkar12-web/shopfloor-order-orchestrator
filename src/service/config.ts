import type { BinMap } from "../intake/adapters.js";
import type { Role } from "./app.js";

/** Storage bins and MES equipment ids of the reference shopfloor, mapped to locations. */
export const DEFAULT_BINS: BinMap = {
  "SM-01*": "WH",
  "SM-02*": "WH-02",
  "LINE-C1-IN": "C1-IN",
  "LINE-C2-IN": "C2-IN",
  "LINE-C3-IN": "C3-IN",
  "LINE-C4-IN": "C4-IN",
  "GI-ZONE*": "OUT",
};

/** API_TOKENS="erp:<token>,viewer:<token>,supervisor:<token>" */
export function parseTokens(spec: string | undefined): Record<string, Role> {
  const out: Record<string, Role> = {};
  for (const pair of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [role, token] = pair.split(":");
    if (!token || !["erp", "viewer", "supervisor"].includes(role!)) throw new Error(`bad API_TOKENS entry "${pair}"`);
    out[token] = role as Role;
  }
  return out;
}
