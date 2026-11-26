# SKILLS.md

## Add a robot form factor

1. Add a `Resource` with its `formFactor`, `edgeId`, capabilities (skill, payload, duration factor) and home location in `referenceShopfloor()`, or in your floor's config.
2. Write or reuse an edge `Driver` (the NOVA OS cell, the VDA 5050 bridge, or a new one) that implements `accepts`, `status` and `start`, and calls `edge.finished` and `edge.resourceDown`.
3. Add an allocator test showing the new resource gets work it can do and none it cannot.

## Add an ERP or WMS source

1. Add a zod schema and a `fromX` adapter in `src/intake/adapters.ts`. The order id must be the source's business key.
2. Add a `confirmationFor` branch with an idempotency key.
3. Add a route in `src/service/app.ts` behind the `erp` role and tests in `test/intake.test.ts` and `test/app.test.ts`.

## Add a command type

1. Extend `Command` in `src/sync/protocol.ts` with a `commandId`, and an epoch if it concerns a task.
2. Handle it in `EdgeAgent.onCommand`, with de-duplication and fencing.
3. Add an edge test for redelivery and for a stale epoch.

## Change the lab method

Write an ADR, run `npm run lab -- dev`, and compare `reports/dev.md`. Held-out numbers change only with that ADR.
