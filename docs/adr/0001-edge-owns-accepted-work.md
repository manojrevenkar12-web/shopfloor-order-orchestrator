# 1. The edge owns work it has accepted

Status: accepted

## Context

A robot cut off from the cloud keeps moving. If the cloud gives that robot's task to another robot after a timeout, both may do it: the same material moved twice, the same batch built twice. If it waits, the order waits.

## Decision

- Work an edge has accepted stays pinned to it. The edge keeps a small local queue (depth 2 per resource) and works through it while offline.
- On reconnect the cloud sends `reconcile` with the tasks it believes the edge holds. The edge answers for each one: accepted, started, its stored result, or `unknown`. An `unknown` task is fenced so a late copy of its command is refused.
- Only after that answer does the cloud reassign anything.
- A resource that goes down hands its unstarted work back (`revoked`) by itself, so a breakdown does not wait for a timeout.

## Consequences

- No duplicate physical executions in the lab.
- Orders held by a cut edge take longer; the README reports that cost separately.
- The cloud-only design, which reassigns after 2 minutes of silence, shows what the alternative costs.
