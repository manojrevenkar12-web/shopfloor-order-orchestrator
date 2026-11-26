Dev run: 3 seeds × 364 days, about 85,800 ERP/MES orders each. Mean ± sd across seeds, per simulated year.

| Metric | Status quo: point-to-point integration | Cloud orchestrator, no edge buffering | Orchestrator: capability routing + edge outbox, fencing, reconcile | Ablation: orchestrator on fixed routes |
|---|---:|---:|---:|---:|
| Duplicate physical executions | 3,297 ± 136 | 510 ± 30 | 0 ± 0 | 0 ± 0 |
| Manual task resets | 583 ± 58 | 448 ± 23 | 0 ± 0 | 0 ± 0 |
| ERP double bookings | 2,146 ± 41 | 0 ± 0 | 0 ± 0 | 0 ± 0 |
| Order lead time p95 (min) | 198 ± 6 | 174 ± 8 | 170 ± 7 | 182 ± 3 |
| Lead time p95, orders hit by a cut (min) | 637 ± 199 | 526 ± 152 | 511 ± 157 | 461 ± 151 |
| Late orders (%) | 3.3 ± 0.4 | 2.7 ± 0.3 | 2.5 ± 0.3 | 2.6 ± 0.2 |
| Lead time p50 (min) | 5.3 ± 0.0 | 4.6 ± 0.0 | 4.6 ± 0.0 | 5.3 ± 0.0 |
| Finished but never booked | 0 ± 0 | 0 ± 0 | 0 ± 0 | 0 ± 0 |
| Cloud-edge traffic (KB/day) | 10,033 ± 0 | 10,026 ± 0 | 10,261 ± 5 | 10,245 ± 8 |

Orchestrator vs point-to-point: lead time p95 -14 %, late orders -23 %, duplicate executions -100 %, manual resets -100 %, ERP double bookings -100 %.
