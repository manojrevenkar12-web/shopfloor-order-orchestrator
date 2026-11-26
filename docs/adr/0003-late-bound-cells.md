# 3. Late-bound cells and skill-based allocation

Status: accepted

## Context

Fixed routes (product → cell, cell → AMR) are how point-to-point integrations work. They leave capable cells idle while another queues, and they need code changes for every new robot.

## Decision

- Tasks ask for skills and payload.
- The cell for a production order is reserved when its material is released, choosing the capable cell with the least queued work. The supply transport goes to that cell's input buffer.
- Transports go to the mobile resource that gets there first, counting its own backlog.

## Consequences

- A humanoid or a new cell type gets work by declaring skills.
- If a reserved cell fails later, the process waits for it; re-routing material is a planned next step (README, Limits).
