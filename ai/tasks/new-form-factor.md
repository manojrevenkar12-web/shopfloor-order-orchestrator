# Task: support a new robot form factor

Context: AGENTS.md invariants 1, 2 and 5; SKILLS.md "Add a robot form factor".

Inputs: the robot's skills with payload limits and speed factors, how it is commanded (NOVA OS program, VDA 5050, vendor API), and how it reports progress and faults.

Done when:
- a `Resource` and a `Driver` exist;
- allocator tests show it gets only work it can do;
- an edge test shows a fault hands its queued work back;
- `npm test` and `npm run lab -- smoke` pass.
