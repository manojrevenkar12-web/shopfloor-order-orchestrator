Held-out run: 5 seeds × 364 days, about 85,800 ERP/MES orders each. Mean ± sd across seeds, per simulated year.

| Metric | Status quo: point-to-point integration | Cloud orchestrator, no edge buffering | Orchestrator: capability routing + edge outbox, fencing, reconcile | Ablation: orchestrator on fixed routes |
|---|---:|---:|---:|---:|
| Duplicate physical executions | 3,335 ± 74 | 490 ± 24 | 0 ± 0 | 0 ± 0 |
| Manual task resets | 574 ± 41 | 436 ± 18 | 0 ± 0 | 0 ± 0 |
| ERP double bookings | 2,205 ± 48 | 0 ± 0 | 0 ± 0 | 0 ± 0 |
| Order lead time p95 (min) | 196 ± 5 | 173 ± 5 | 170 ± 5 | 182 ± 3 |
| Lead time p95, orders hit by a cut (min) | 634 ± 317 | 461 ± 59 | 435 ± 48 | 400 ± 48 |
| Late orders (%) | 3.2 ± 0.2 | 2.6 ± 0.2 | 2.5 ± 0.2 | 2.5 ± 0.2 |
| Lead time p50 (min) | 5.3 ± 0.0 | 4.6 ± 0.0 | 4.6 ± 0.0 | 5.3 ± 0.0 |
| Finished but never booked | 0 ± 0 | 0 ± 0 | 0 ± 0 | 0 ± 0 |
| Cloud-edge traffic (KB/day) | 10,033 ± 0 | 10,026 ± 0 | 10,264 ± 10 | 10,250 ± 9 |

Orchestrator vs point-to-point: lead time p95 -13 %, late orders -20 %, duplicate executions -100 %, manual resets -100 %, ERP double bookings -100 %.
