# Security model

Trace content is untrusted. It can contain prompt injection, secrets, personal information, misleading success claims, or instructions designed to alter the evaluator. WikiSkill treats it as evidence, never as executable instructions.

## Controls

- No project is imported without explicit project-ID consent.
- Events with origin `geode-wikiskill` are excluded by both the provider request and consumer validation.
- Agent Threads must sanitize trace events; WikiSkill performs a second pass for configured secrets, tokens, email addresses, SSNs, and credential assignments.
- Authoring prompts wrap trace-derived text in an explicit untrusted evidence boundary and require schema-validated JSON.
- Candidates are never placed in any active skill root and are never loaded into an evaluator implicitly.
- Baseline and candidate run independently through `constrainedRuns` with one turn, explicit timeout, no requested tools, and caller idempotency keys.
- Critical fixture regressions, equal results, and insufficient gains are rejected.
- Evaluation can only produce `reject` or `review`; there is no activation, merge, push, or release capability.
- Absolute raw-log paths and provider credentials are absent from the structural API contract.

## Provider trust requirement

The constrained-run provider must enforce no filesystem, tools, MCP servers, skills, settings sources, or session persistence. WikiSkill refuses to substitute ordinary threads for evaluation. Provider canary tests belong to Agent Threads, not this consumer plugin.

## Residual risks

Pattern text may still contain identifying context that deterministic redaction cannot recognize. Review packets require human inspection. A future release should add configurable entity detection and retention cleanup after the pilot establishes acceptable false-positive and false-negative rates.
