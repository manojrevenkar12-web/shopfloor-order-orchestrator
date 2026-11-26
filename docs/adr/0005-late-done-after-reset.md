# 5. Supervisor resets: late done reports count, and the edge takes over re-sent work

Status: accepted

## Context

The first held-out run was stopped before it finished. By then it had printed 17 of its 20 per-run summary lines. The three cloud-only runs that were left (seeds 1001, 1002 and 1005) were taking far longer than the others.

The run was stopped because of two bugs. The first was found as follows:

- A probe of seed 1001 showed active tasks growing without bound after about day 244.
- The cause was in `Orchestrator.apply`. A supervisor reset (`manualResetAfterMs`) puts a task back to READY at the same epoch. When the original run's `done` report arrived after the reset:
  - the lifecycle table refused READY → DONE, so the task stayed READY;
  - the handler still took the task out of the active set.
- The task was then invisible to every later tick, and the tasks that depended on it waited forever.
- The control loop scans the active set, so each tick got slower as the backlog grew. That is why those runs barely moved.

A second bug showed up when the dev seeds were re-run: cloud-only seed 3 slowed down after about day 190.

- A supervisor reset sends the task again at a higher epoch.
- The edge fenced the new epoch but queued a second copy of a task it already held.
- The stale copy ran, and its reports were fenced off as stale, so the cloud heard nothing at the new epoch and reset the task again.
- C4 ended up with tasks at epoch ~980 and 1,295 process tasks waiting behind it.

Both bugs can only happen after a supervisor reset or a retry. The `orchestrator` and `orchestrator-static` designs had no resets on any seed, so their dev results and the held-out lines already printed are unchanged by the fix. Only the two baselines move.

## Decision

- READY → DONE and FAILED → DONE are legal task transitions. A `done` report at the current epoch means the work happened on the floor, so the cloud records it rather than running the work a second time.
- A task leaves the active set only once it really is DONE. `move()` reports whether the transition happened, and the `done` handler stops when it didn't.
- When a dispatch arrives at a newer epoch for a task the edge already holds, the edge moves the held copy to the new epoch and reports it (`started` or `accepted`). It does not queue a second copy. If the held copy was queued for a different resource, it is dropped and the new assignment is queued.
- `test/edge.test.ts` covers the take-over. `test/lateDone.test.ts` covers the reset-then-late-done sequence for every design, and covers that a task is never orphaned.

## Consequences

- The held-out seeds ran again from scratch, all 20 runs, with `--force --reason=ADR-0005`. The lock records the reason.
- The dev seeds were re-run and `reports/dev.*` regenerated with the fix.
- The fix makes the baselines better (fewer stuck orders), not worse, so it narrows the gap the platform is measured against. No orchestrator setting was changed after the held-out lines were seen.
