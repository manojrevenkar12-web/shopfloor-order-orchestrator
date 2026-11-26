import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EdgeAgent, ROBUST_EDGE, type Driver } from "../src/sync/edge.js";
import { MemoryEdgeStore, SqliteEdgeStore, type EdgeStore } from "../src/sync/edgeStore.js";
import type { Command, EdgeMessage, TaskEvent, TaskSpec } from "../src/sync/protocol.js";

const spec = (taskId = "MES-1/1", resourceId = "amr-1"): TaskSpec => ({ taskId, orderId: "MES-1", kind: "transport", skills: ["transport"], product: "X", quantity: 1, weightKg: 10, durationMs: 60_000, from: "WH", to: "C1-IN", resourceId });

class FakeDriver implements Driver {
  started: string[] = [];
  ready = true;
  accepts() {
    return true;
  }
  status() {
    return { ready: this.ready, location: "WH" };
  }
  start(s: TaskSpec) {
    this.started.push(s.taskId);
  }
}

function edge(cfg = ROBUST_EDGE, store: EdgeStore = new MemoryEdgeStore()) {
  const sent: EdgeMessage[] = [];
  let handler: (c: Command) => void = () => {};
  const driver = new FakeDriver();
  let now = 0;
  const agent = new EdgeAgent("fleet", ["amr-1", "amr-2"], { send: (m) => sent.push(m), onCommand: (h) => (handler = h) }, driver, cfg, store, () => now);
  const events = () => sent.filter((m): m is TaskEvent => m.type === "event");
  return { agent, driver, sent, events, cmd: (c: Command) => handler(c), setNow: (t: number) => (now = t) };
}

const dispatch = (commandId: string, epoch: number, s = spec()): Command => ({ type: "dispatch", commandId, epoch, spec: s, sentAt: 0 });

describe("edge agent", () => {
  it("executes a redelivered dispatch once and acknowledges it again", () => {
    const e = edge();
    e.cmd(dispatch("c1", 1));
    e.cmd(dispatch("c1", 1));
    expect(e.driver.started).toEqual(["MES-1/1"]);
    expect(e.events().filter((x) => x.kind === "accepted")).toHaveLength(2);
  });

  it("takes over held work when the cloud re-sends it at a newer epoch, instead of running it twice", () => {
    const e = edge();
    e.cmd(dispatch("c1", 1, spec("MES-1/1")));
    e.cmd(dispatch("c2", 1, spec("MES-2/1")));
    // MES-1/1 is running, MES-2/1 is queued; both come again at epoch 2 after a supervisor reset.
    e.cmd(dispatch("c3", 2, spec("MES-1/1")));
    e.cmd(dispatch("c4", 2, spec("MES-2/1")));
    e.agent.finished("amr-1", "MES-1/1", true, 1);
    e.agent.finished("amr-1", "MES-2/1", true, 2);
    expect(e.driver.started).toEqual(["MES-1/1", "MES-2/1"]);
    const done = e.events().filter((x) => x.kind === "done");
    expect(done.map((x) => [x.taskId, x.epoch])).toEqual([["MES-1/1", 2], ["MES-2/1", 2]]);
  });

  it("without de-duplication a redelivery runs the task twice (the point-to-point failure)", () => {
    const e = edge({ dedupeCommands: false, fencing: false, outbox: false, resendEveryMs: 1000 });
    e.cmd(dispatch("c1", 0));
    e.cmd(dispatch("c2", 0));
    e.agent.finished("amr-1", "MES-1/1", true, 1);
    expect(e.driver.started).toEqual(["MES-1/1", "MES-1/1"]);
  });

  it("refuses a command with an older epoch than it has seen", () => {
    const e = edge();
    e.cmd(dispatch("c2", 2));
    e.agent.finished("amr-1", "MES-1/1", true, 1);
    e.cmd(dispatch("c1", 1));
    expect(e.driver.started).toEqual(["MES-1/1"]);
    expect(e.events().at(-1)).toMatchObject({ kind: "rejected", reason: "stale epoch 1 < 2" });
  });

  it("keeps events until acknowledged and resends them", () => {
    const e = edge();
    e.cmd(dispatch("c1", 1));
    e.agent.finished("amr-1", "MES-1/1", true, 5);
    expect(e.agent.outboxSize).toBe(3); // accepted, started, done
    e.sent.length = 0;
    e.agent.tick(20_000);
    expect(e.events().map((x) => x.seq)).toEqual([1, 2, 3]);
    e.cmd({ type: "ack", upToSeq: 2 });
    expect(e.agent.outboxSize).toBe(1);
  });

  it("reports unknown for a task it never got and fences a late copy of that command", () => {
    const e = edge();
    e.cmd({ type: "reconcile", commandId: "r1", held: [{ taskId: "MES-9/1", epoch: 3 }], sentAt: 0 });
    expect(e.events().at(-1)).toMatchObject({ taskId: "MES-9/1", kind: "unknown" });
    e.cmd(dispatch("late", 3, spec("MES-9/1")));
    expect(e.driver.started).toEqual([]);
    e.cmd(dispatch("new", 4, spec("MES-9/1")));
    expect(e.driver.started).toEqual(["MES-9/1"]);
  });

  it("gives back queued work when a resource goes down, and fails the running one", () => {
    const e = edge();
    e.cmd(dispatch("c1", 1, spec("A/1")));
    e.cmd(dispatch("c2", 1, spec("B/1")));
    e.driver.ready = false;
    e.agent.resourceDown("amr-1", 10);
    const kinds = e.events().filter((x) => x.at === 10).map((x) => `${x.taskId}:${x.kind}`);
    expect(kinds).toEqual(["B/1:revoked", "A/1:failed"]);
  });

  it("revokes work that has not started; started work stays and says so", () => {
    const e = edge();
    e.cmd(dispatch("c1", 1, spec("A/1")));
    e.cmd(dispatch("c2", 1, spec("B/1")));
    e.cmd({ type: "revoke", commandId: "v1", taskId: "B/1", epoch: 2, sentAt: 0 });
    e.cmd({ type: "revoke", commandId: "v2", taskId: "A/1", epoch: 2, sentAt: 0 });
    const last = e.events().slice(-2).map((x) => `${x.taskId}:${x.kind}`);
    expect(last).toEqual(["B/1:revoked", "A/1:started"]);
  });
});

describe("durable edge store", () => {
  it("keeps the outbox, the inbox and the fences across a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "edge-")), "edge.sqlite");
    const s1 = new SqliteEdgeStore(path);
    const e1 = edge(ROBUST_EDGE, s1);
    e1.cmd(dispatch("c1", 5));
    e1.agent.finished("amr-1", "MES-1/1", true, 9);
    e1.cmd({ type: "ack", upToSeq: 1 });
    s1.close();

    const s2 = new SqliteEdgeStore(path);
    expect(s2.unacked().map((x) => x.kind)).toEqual(["started", "done"]);
    expect(s2.seen("c1")).toBe(true);
    expect(s2.epoch("MES-1/1")).toBe(5);
    expect(s2.nextSeq()).toBe(4);
    s2.close();
  });
});
