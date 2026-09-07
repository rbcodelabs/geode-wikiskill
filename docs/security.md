# Security model

Trace content is untrusted. It can contain prompt injection, secrets, personal information, misleading success claims, or instructions designed to alter the evaluator. WikiSkill treats it as evidence, never as executable instructions.

## Controls

- No project is imported without explicit project-ID consent.
- Events with origin `geode-wikiskill` are excluded by both the provider request and consumer validation.
- Agent Threads must sanitize trace events; WikiSkill obtains configured values by ID from Geode Secret Storage and performs a second pass for those secrets, tokens, email addresses, SSNs, and credential assignments. Secret values never enter plugin state. Import blocks if the storage or a configured ID is unavailable.
- Authoring prompts wrap trace-derived text in an explicit untrusted evidence boundary and require schema-validated JSON.
- Candidates are never placed in any active skill root and are never loaded into an evaluator implicitly.
- Baseline and candidate run independently for every public and holdout fixture through `constrainedRuns`. Outputs must be JSON matching each closed schema and are graded locally by the named deterministic grader. Idempotency binds all content, contract, fixture, role, and execution hashes.
- Critical fixture regressions, equal results, and insufficient gains are rejected.
- Evaluation can only produce `reject` or `review`; there is no activation, merge, push, or release capability.
- Absolute raw-log paths and provider credentials are absent from the structural API contract.

## Provider trust requirement

The constrained-run provider must enforce no filesystem, tools, MCP servers, skills, settings sources, or session persistence. WikiSkill refuses to substitute ordinary threads for evaluation. Provider canary tests belong to Agent Threads, not this consumer plugin.

## Residual risks

Pattern text may still contain identifying context that deterministic redaction cannot recognize, so review packets require human inspection. Operational retention removes expired evidence, candidates, and evaluations on every scheduler cycle—including cycles with no import work or a provider failure. Configurable entity detection remains a possible follow-up after the pilot establishes acceptable false-positive and false-negative rates.
