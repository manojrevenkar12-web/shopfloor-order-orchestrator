import { describe, expect, it } from "vitest";
import { referenceShopfloor } from "../src/domain/shopfloor.js";
import { EdgeAgent, ROBUST_EDGE } from "../src/sync/edge.js";
import type { EdgeMessage, TaskEvent, TaskSpec } from "../src/sync/protocol.js";
import { Vda5050Driver } from "../src/vda5050/driver.js";
import { interpretState, toVdaOrder, topic } from "../src/vda5050/translate.js";
import type { StateMessage } from "../src/vda5050/types.js";

const { layout, resources } = referenceShopfloor();
const spec: TaskSpec = { taskId: "EWM-7/1", orderId: "EWM-7", kind: "transport", skills: ["transport"], product: "HU", quantity: 1, weightKg: 120, durationMs: 90_000, from: "WH", to: "C2-IN", resourceId: "amr-2" };
const vehicle = { manufacturer: "acme", serialNumber: "amr-2" };

function state(over: Partial<StateMessage>): StateMessage {
  return { headerId: 1, timestamp: "2026-01-05T06:00:00Z", version: "2.0.0", manufacturer: "acme", serialNumber: "amr-2", orderId: "EWM-7/1@3", orderUpdateId: 0, lastNodeId: "WH", lastNodeSequenceId: 0, driving: false, operatingMode: "AUTOMATIC", nodeStates: [], edgeStates: [], actionStates: [], errors: [], ...over };
}

describe("VDA 5050 translation", () => {
  it("builds an order with even node and odd edge sequence ids and HARD pick/drop", () => {
    const o = toVdaOrder(spec, 3, vehicle, layout, 42, new Date("2026-01-05T06:00:00Z"));
    expect(o).toMatchObject({ headerId: 42, version: "2.0.0", orderId: "EWM-7/1@3", orderUpdateId: 0 });
    expect(o.nodes.map((n) => [n.nodeId, n.sequenceId])).toEqual([["WH", 0], ["C2-IN", 2]]);
    expect(o.edges).toEqual([{ edgeId: "WH->C2-IN", sequenceId: 1, released: true, startNodeId: "WH", endNodeId: "C2-IN", actions: [] }]);
    expect(o.nodes[0]!.actions[0]).toMatchObject({ actionType: "pick", blockingType: "HARD" });
    expect(o.nodes[1]!.nodePosition).toEqual({ x: 40, y: 30, mapId: "floor-1" });
    expect(topic(vehicle, "order")).toBe("uagv/v2/acme/amr-2/order");
  });

  it("refuses to send a process step or an unbound transport to a vehicle", () => {
    expect(() => toVdaOrder({ ...spec, kind: "process" }, 1, vehicle, layout, 1, new Date())).toThrow();
    const { to: _to, ...unbound } = spec;
    expect(() => toVdaOrder(unbound as TaskSpec, 1, vehicle, layout, 1, new Date())).toThrow();
  });

  it("reads started, done and failed from vehicle states, and ignores other orders", () => {
    const id = "EWM-7/1@3";
    expect(interpretState(state({ driving: true }), id)).toEqual({ kind: "started" });
    expect(interpretState(state({ lastNodeId: "C2-IN", actionStates: [{ actionId: `${id}:drop`, actionStatus: "FINISHED" }] }), id)).toEqual({ kind: "done", location: "C2-IN" });
    expect(interpretState(state({ errors: [{ errorType: "noRouteError", errorLevel: "FATAL" }] }), id)).toEqual({ kind: "failed", reason: "noRouteError" });
    expect(interpretState(state({ orderId: "other" }), id)).toEqual({ kind: "none" });
  });
});

describe("VDA 5050 edge driver", () => {
  it("publishes the order, and a FINISHED drop becomes a done event", () => {
    const published: Array<[string, string]> = [];
    const amrs = resources.filter((r) => r.edgeId === "fleet-vda5050");
    const driver = new Vda5050Driver(amrs, layout, (t, p) => published.push([t, p]), "acme", () => 1000);
    const sent: EdgeMessage[] = [];
    const agent = new EdgeAgent("fleet-vda5050", amrs.map((r) => r.id), { send: (m) => sent.push(m), onCommand: () => {} }, driver, ROBUST_EDGE);
    driver.edge = agent;
    driver.onState(state({ orderId: "", lastNodeId: "CHARGE" })); // vehicle comes online in AUTOMATIC
    agent.onCommand({ type: "dispatch", commandId: "c1", epoch: 1, spec, sentAt: 0 }, 0);
    expect(published).toHaveLength(1);
    const order = JSON.parse(published[0]![1]!);
    expect(published[0]![0]).toBe("uagv/v2/acme/amr-2/order");
    driver.onState(state({ orderId: order.orderId, lastNodeId: "C2-IN", actionStates: [{ actionId: `${order.orderId}:drop`, actionStatus: "FINISHED" }] }));
    const events = sent.filter((m): m is TaskEvent => m.type === "event").map((e) => e.kind);
    expect(events).toEqual(["accepted", "started", "done"]);
    expect(driver.status("amr-2").location).toBe("C2-IN");
  });

  it("a vehicle switched to MANUAL hands its work back", () => {
    const amrs = resources.filter((r) => r.edgeId === "fleet-vda5050");
    const driver = new Vda5050Driver(amrs, layout, () => {}, "acme");
    const sent: EdgeMessage[] = [];
    const agent = new EdgeAgent("fleet-vda5050", amrs.map((r) => r.id), { send: (m) => sent.push(m), onCommand: () => {} }, driver, ROBUST_EDGE);
    driver.edge = agent;
    driver.onState(state({ orderId: "" }));
    agent.onCommand({ type: "dispatch", commandId: "c1", epoch: 1, spec, sentAt: 0 }, 0);
    driver.onState(state({ operatingMode: "MANUAL" }));
    expect(sent.filter((m): m is TaskEvent => m.type === "event").at(-1)).toMatchObject({ kind: "failed", reason: "resource down" });
  });
});
