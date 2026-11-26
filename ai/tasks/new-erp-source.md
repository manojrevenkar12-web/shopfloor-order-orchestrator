# Task: connect a new ERP or WMS source

Context: AGENTS.md invariant 4; SKILLS.md "Add an ERP or WMS source".

Inputs: a sample payload, the business key, the location mapping, and how the source wants confirmations (endpoint, idempotency).

Done when:
- the adapter rejects malformed payloads with a reason;
- a re-sent payload is recognised as a duplicate;
- the confirmation carries an idempotency key;
- the intake and app tests cover all three.
