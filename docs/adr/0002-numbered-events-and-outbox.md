# 2. Gap-free numbered events with an outbox on the edge

Status: accepted

## Context

JetStream delivers at least once, links drop, and the edge may restart. The cloud needs every state change exactly once and in order. Otherwise a `done` can be lost and the task hangs until a supervisor resets it, which is the cloud-only design's failure.

## Decision

- Every edge event gets the next number from the edge's durable store and stays in its outbox until the cloud acknowledges it.
- The cloud applies events per edge in number order. It buffers anything that arrives early and ignores anything at or below the last applied number.
- JetStream's message id (`<edge>:<seq>`) drops resends within its duplicate window; the sequence check covers everything outside it.

## Consequences

- The edge store must be durable: `SqliteEdgeStore` on the gateway's disk.
- A few hundred bytes of outbox per pending event, and periodic resends while the link is down.
