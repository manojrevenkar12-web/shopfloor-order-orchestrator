import { DatabaseSync } from "node:sqlite";
import type { TaskEvent } from "./protocol.js";

/**
 * What an edge must not forget across a restart or a long disconnect: the events the cloud has
 * not acknowledged (outbox), the commands it already applied (inbox, for de-duplication) and the
 * highest epoch it has seen per task (the fence).
 */
export interface EdgeStore {
  nextSeq(): number;
  append(event: TaskEvent): void;
  unacked(): TaskEvent[];
  ackUpTo(seq: number): void;
  seen(commandId: string): boolean;
  remember(commandId: string): void;
  epoch(taskId: string): number | undefined;
  setEpoch(taskId: string, epoch: number): void;
}

export class MemoryEdgeStore implements EdgeStore {
  private seq = 0;
  private outbox: TaskEvent[] = [];
  private inbox = new Set<string>();
  private inboxOrder: string[] = [];
  private epochs = new Map<string, number>();

  constructor(private readonly inboxLimit = 50_000) {}

  nextSeq(): number {
    return ++this.seq;
  }

  append(event: TaskEvent): void {
    this.outbox.push(event);
  }

  unacked(): TaskEvent[] {
    return this.outbox;
  }

  ackUpTo(seq: number): void {
    if (this.outbox.length && this.outbox[0]!.seq <= seq) this.outbox = this.outbox.filter((e) => e.seq > seq);
  }

  seen(commandId: string): boolean {
    return this.inbox.has(commandId);
  }

  remember(commandId: string): void {
    if (this.inbox.has(commandId)) return;
    this.inbox.add(commandId);
    this.inboxOrder.push(commandId);
    if (this.inboxOrder.length > this.inboxLimit) this.inbox.delete(this.inboxOrder.shift()!);
  }

  epoch(taskId: string): number | undefined {
    return this.epochs.get(taskId);
  }

  setEpoch(taskId: string, epoch: number): void {
    this.epochs.set(taskId, epoch);
    if (this.epochs.size > 100_000) {
      const first = this.epochs.keys().next().value;
      if (first !== undefined) this.epochs.delete(first);
    }
  }
}

/** Durable edge state on the gateway's disk (node:sqlite), so a reboot loses neither events nor fences. */
export class SqliteEdgeStore implements EdgeStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists meta (k text primary key, v integer not null);
      create table if not exists outbox (seq integer primary key, body text not null);
      create table if not exists inbox (command_id text primary key);
      create table if not exists fence (task_id text primary key, epoch integer not null);
      insert or ignore into meta (k, v) values ('seq', 0);
    `);
  }

  nextSeq(): number {
    this.db.prepare("update meta set v = v + 1 where k = 'seq'").run();
    return Number((this.db.prepare("select v from meta where k = 'seq'").get() as { v: number }).v);
  }

  append(event: TaskEvent): void {
    this.db.prepare("insert into outbox (seq, body) values (?, ?)").run(event.seq, JSON.stringify(event));
  }

  unacked(): TaskEvent[] {
    return (this.db.prepare("select body from outbox order by seq").all() as Array<{ body: string }>).map((r) => JSON.parse(r.body) as TaskEvent);
  }

  ackUpTo(seq: number): void {
    this.db.prepare("delete from outbox where seq <= ?").run(seq);
  }

  seen(commandId: string): boolean {
    return this.db.prepare("select 1 from inbox where command_id = ?").get(commandId) !== undefined;
  }

  remember(commandId: string): void {
    this.db.prepare("insert or ignore into inbox (command_id) values (?)").run(commandId);
  }

  epoch(taskId: string): number | undefined {
    const row = this.db.prepare("select epoch from fence where task_id = ?").get(taskId) as { epoch: number } | undefined;
    return row?.epoch;
  }

  setEpoch(taskId: string, epoch: number): void {
    this.db.prepare("insert into fence (task_id, epoch) values (?, ?) on conflict(task_id) do update set epoch = excluded.epoch").run(taskId, epoch);
  }

  close(): void {
    this.db.close();
  }
}
