# AGENTS.md

Rules for anyone, human or agent, changing this repository.

## Invariants

1. **A physical task runs once.** Every path from the cloud to a robot carries a stable command id and an epoch. The edge de-duplicates by command id and refuses older epochs. Do not add a command type without both.
2. **Accepted work belongs to its edge until the edge says otherwise.** The cloud may take back only work the edge never accepted, and only after a reconcile answer (`unknown`, `revoked`, `rejected`). Do not add a timeout that reassigns ACCEPTED or RUNNING work.
3. **Edge events are numbered without gaps and kept until acknowledged.** The edge store must be durable in deployment (`SqliteEdgeStore`). The cloud applies them once and in order.
4. **Every ERP confirmation goes through the outbox with an idempotency key.** No direct ERP calls from handlers.
5. **Skills, not robot types.** Planner and allocator ask for skills and payload. A new form factor is a new `Resource` with capabilities, never a branch on `formFactor` in the planner.
6. **The assistant is read-only.** It gets facts built by code and returns text. Model output goes through `groundingProblems`; on failure the template is used.
7. **The lab and the service share the same code.** The lab only replaces the network, the drivers and the ERP. Never put lab-only logic in `src/sync`.
8. **Held-out seeds run once.** Tune on dev seeds. `reports/heldout.*`, `lab/heldout.lock`, the README block and `dashboard/public/data/results.json` are generated. A method change that needs new held-out numbers needs an ADR and `--force --reason=`.
9. **No magic numbers in the dashboard.** Use the tokens in `dashboard/src/theme/tokens.css`. Every view has loading, error and empty states.

## Commands

| Task | Command |
|---|---|
| Typecheck | `npm run typecheck` |
| Unit and scenario tests | `npm test` |
| JetStream integration | `NATS_SERVER_BIN=… npm run test:nats` |
| Lab | `npm run lab -- smoke` / `dev` / `check` |
| Dashboard | `cd dashboard && npm ci && npm run typecheck && npm test && npm run build` |

## Conventions

- TypeScript strict, ESM, Node 22. Time is epoch milliseconds inside the core.
- Tests are vitest, and their names describe the behaviour. Scenario tests use `test/helpers.ts` (`rig`).
- Commit messages say what changed and why. The author is Manoj Kumar Prakash.
