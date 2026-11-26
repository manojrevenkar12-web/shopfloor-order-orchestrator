import { describe, expect, it } from "vitest";
import { explain, factsFor, groundingProblems, stuckOrders } from "../src/agent/exceptions.js";
import { design } from "../src/lab/designs.js";
import { order, rig, T0 } from "./helpers.js";

const platform = design("orchestrator");

function stuckRig() {
  const r = rig(platform.cloud, platform.edge);
  r.cloud.intake(order({ orderId: "EWM-1", kind: "transfer", from: "WH", to: "OUT", weightKg: 300, dueAt: T0 + 20 * 60_000 }), T0);
  r.engine.at(T0 + 20_000, () => r.network.setCut("fleet-vda5050", true));
  r.until(40 * 60_000);
  const edgeOf = (id: string) => r.resources.find((x) => x.id === id)?.edgeId;
  return { r, edgeOf, now: T0 + 40 * 60_000 };
}

describe("shift exception assistant", () => {
  it("lists an order that is past due and explains it from facts", async () => {
    const { r, edgeOf, now } = stuckRig();
    expect(stuckOrders(r.cloud, now)).toEqual(["EWM-1"]);
    const f = factsFor(r.cloud, "EWM-1", now, edgeOf)!;
    expect(f.findings.join(" ")).toMatch(/held by edge fleet-vda5050, offline for \d+ min/);
    const e = await explain(f);
    expect(e.source).toBe("template");
    expect(e.text).toContain("20 min past due");
    expect(groundingProblems(e.text, f)).toEqual([]);
  });

  it("uses a grounded model draft and rejects one that invents a number or a robot", async () => {
    const { r, edgeOf, now } = stuckRig();
    const f = factsFor(r.cloud, "EWM-1", now, edgeOf)!;
    const good = await explain(f, async () => "EWM-1 is 20 min past due because edge fleet-vda5050 is offline and still holds EWM-1/1.");
    expect(good.source).toBe("model");
    const bad = await explain(f, async () => "EWM-1 will be done in 7 minutes by amr-9.");
    expect(bad.source).toMatch(/^template \(draft rejected/);
    expect(bad.rejectedDraft).toContain("amr-9");
    const down = await explain(f, async () => {
      throw new Error("offline");
    });
    expect(down.source).toBe("template (model unavailable: offline)");
  });
});
