# Architecture

## Boundaries

WikiSkill owns discovery, friction analysis, accumulated knowledge, evaluation scenarios, proposal state, and review artifacts. Installed skills are read-only inputs. No package-specific contract is required, and no Agentic PM package is a runtime dependency.

The host supplies vault, workspace, settings, and plugin lifecycle APIs. Agent Threads supplies optional sanitized execution traces and constrained model execution. Local discovery and scanning remain available when that provider is offline.

## Data flow

1. Discover skills from conventional and explicitly configured directories, preserving source identity and a content hash.
2. Scan bounded batches of vault Markdown and optionally import consented Agent Threads traces.
3. Redact evidence and preserve source references. Distinguish inferred vault observations from provider-attributed execution outcomes.
4. Group friction into patterns with supporting observations and counterexamples.
5. Request a proposal through a constrained run, supplying relevant evidence and the discovered baseline where available.
6. Record evaluation or an explicit unverified result, and present the proposal for human review.
7. Export review material. Applying it to a maintained skill remains a separate action.

## Persistence

Schema-versioned plugin state stores discovery results, scan progress, evidence, patterns, jobs, proposals, review decisions, and budget data. A document's content hash identifies the version that produced its evidence. Source changes invalidate the corresponding observations when revisited. Scan cursors allow bounded batches to advance across the vault.

Knowledge output is excluded from subsequent scans to prevent a proposal from becoming evidence for itself. Output-root history and generated-content markers support this exclusion when settings or note locations change.

## Execution boundary

`src/threads-contract.ts` contains the structural subset of the Agent Threads public API consumed by the plugin. `src/threads-adapter.ts` handles provider discovery, capabilities, and lifecycle. Skill discovery uses filesystem locations rather than private Agent Threads settings.

Authoring and model comparisons require constrained execution. Input includes untrusted evidence; ordinary host-capable threads are not a substitute. Review approval is separate from execution and does not grant permission to write installed skills.

## Limitations

The initial scanner uses text rules, not a comprehensive semantic analysis of the entire vault. Skill associations and friction explanations require human judgment. Evaluation scenarios stored by WikiSkill can demonstrate behavior for those cases, but generated cases do not constitute independent proof of general improvement. UI and reports must preserve that distinction.
