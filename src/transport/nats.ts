import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, type ConsumerMessages, type JetStreamClient } from "@nats-io/jetstream";
import { connect, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import type { CloudSide, Command, EdgeMessage, EdgeSide, TaskEvent } from "../sync/protocol.js";

/**
 * The cloud-edge link on NATS JetStream (the broker NOVA OS already exposes).
 *
 * - Commands: stream NOVA_CMD, subject `nova.edge.<edgeId>.cmd`, one durable consumer per edge.
 * - Task events: stream NOVA_EVT, subject `nova.cloud.events.<edgeId>`, one durable consumer for the cloud.
 * - Heartbeats: plain NATS on `nova.cloud.heartbeat.<edgeId>` (losing one is harmless).
 *
 * Publishes carry a message id (command id, or edge id + seq), so JetStream drops a resend inside
 * its duplicate window; outside it the application's own de-duplication still holds. Delivery is
 * at-least-once: handlers run before the ack, and a crash between the two redelivers.
 */
export const STREAMS = {
  commands: { name: "NOVA_CMD", subjects: ["nova.edge.*.cmd"] },
  events: { name: "NOVA_EVT", subjects: ["nova.cloud.events.*"] },
} as const;

export const subjects = {
  command: (edgeId: string) => `nova.edge.${edgeId}.cmd`,
  event: (edgeId: string) => `nova.cloud.events.${edgeId}`,
  heartbeat: (edgeId: string) => `nova.cloud.heartbeat.${edgeId}`,
};

export interface NatsLink {
  close(): Promise<void>;
  /** Publishes that failed (broker unreachable); the caller's outbox resends them. */
  readonly publishErrors: number;
}

export async function ensureStreams(nc: NatsConnection, duplicateWindowMs = 120_000): Promise<void> {
  const jsm = await jetstreamManager(nc);
  for (const s of [STREAMS.commands, STREAMS.events]) {
    const cfg = { name: s.name, subjects: [...s.subjects], duplicate_window: duplicateWindowMs * 1_000_000, max_age: 7 * 24 * 3600 * 1e9 };
    try {
      await jsm.streams.info(s.name);
      await jsm.streams.update(s.name, { subjects: cfg.subjects, duplicate_window: cfg.duplicate_window, max_age: cfg.max_age });
    } catch {
      await jsm.streams.add(cfg);
    }
  }
}

async function durable(nc: NatsConnection, stream: string, name: string, filter: string) {
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.consumers.info(stream, name);
  } catch {
    await jsm.consumers.add(stream, { durable_name: name, filter_subject: filter, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ack_wait: 30 * 1e9 });
  }
  return jetstream(nc).consumers.get(stream, name);
}

/** Holds messages that arrive before the application registered its handler, so none is acked unseen. */
function mailbox<T>() {
  let handler: ((m: T) => void) | undefined;
  const early: T[] = [];
  return {
    deliver(m: T) {
      if (handler) handler(m);
      else early.push(m);
    },
    set(h: (m: T) => void) {
      handler = h;
      for (const m of early.splice(0)) h(m);
    },
  };
}

function publisher(js: JetStreamClient, onError: () => void) {
  return (subject: string, body: unknown, msgID?: string) => {
    js.publish(subject, JSON.stringify(body), msgID ? { msgID } : undefined).catch(onError);
  };
}

/** The orchestrator's side. */
export async function natsCloudSide(servers: string): Promise<CloudSide & NatsLink> {
  const nc = await connect({ servers, name: "orchestrator", maxReconnectAttempts: -1 });
  await ensureStreams(nc);
  const js = jetstream(nc);
  let errors = 0;
  const pub = publisher(js, () => errors++);
  const box = mailbox<EdgeMessage>();
  const consumer = await durable(nc, STREAMS.events.name, "orchestrator", "nova.cloud.events.*");
  const messages: ConsumerMessages = await consumer.consume();
  void (async () => {
    for await (const m of messages) {
      try {
        box.deliver(m.json<TaskEvent>());
      } finally {
        m.ack();
      }
    }
  })();
  const hb: Subscription = nc.subscribe("nova.cloud.heartbeat.*", { callback: (_e, m) => box.deliver(m.json<EdgeMessage>()) });
  return {
    send(edgeId: string, cmd: Command) {
      pub(subjects.command(edgeId), cmd, "commandId" in cmd ? cmd.commandId : undefined);
    },
    onMessage(h) {
      box.set(h);
    },
    get publishErrors() {
      return errors;
    },
    async close() {
      hb.unsubscribe();
      await messages.close();
      await nc.drain();
    },
  };
}

/** An edge gateway's side. */
export async function natsEdgeSide(servers: string, edgeId: string): Promise<EdgeSide & NatsLink> {
  const nc = await connect({ servers, name: `edge-${edgeId}`, maxReconnectAttempts: -1 });
  await ensureStreams(nc);
  const js = jetstream(nc);
  let errors = 0;
  const pub = publisher(js, () => errors++);
  const box = mailbox<Command>();
  const consumer = await durable(nc, STREAMS.commands.name, `edge-${edgeId}`, subjects.command(edgeId));
  const messages = await consumer.consume();
  void (async () => {
    for await (const m of messages) {
      try {
        box.deliver(m.json<Command>());
      } finally {
        m.ack();
      }
    }
  })();
  return {
    send(msg: EdgeMessage) {
      if (msg.type === "heartbeat") nc.publish(subjects.heartbeat(edgeId), JSON.stringify(msg));
      else pub(subjects.event(edgeId), msg, `${edgeId}:${msg.seq}`);
    },
    onCommand(h) {
      box.set(h);
    },
    get publishErrors() {
      return errors;
    },
    async close() {
      await messages.close();
      await nc.drain();
    },
  };
}
