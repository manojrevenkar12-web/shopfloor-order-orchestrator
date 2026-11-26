# 4. Held-out seeds run once

Status: accepted

## Decision

- Dev seeds 1–3 are for tuning.
- Held-out seeds 1001–1005 ran once. `lab/heldout.lock` stores the SHA-256 of `reports/heldout.json`.
- `lab heldout` refuses to run again without `--force --reason=<ADR>`.
- CI checks the hash, the README block and the dashboard data, and that a second run is refused.
