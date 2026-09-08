# WikiSkill Evolution

WikiSkill Evolution is a desktop-only Geode/Obsidian-compatible plugin that turns consented Agent Threads experience into persistent patterns, isolated skill candidates, paired evaluations, and human review packets.

It never edits or activates a skill. Agent Threads owns raw traces and constrained execution; WikiSkill stores only sanitized evidence-derived knowledge and review artifacts.

This work is based on [“WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution”](https://arxiv.org/abs/2608.27454) by Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan, and Tu Vu (arXiv:2608.27454). This pilot adapts the paper’s separation of raw experience, persistent knowledge, and executable skills while adding Geode-specific consent, constrained execution, deterministic and holdout evaluation, and human-only promotion.

## Pilot status

The first governed scope is Agentic PM Playbook's `integration-routing` skill. This repository contains a complete vertical plugin pilot and a pinned structural Agent Threads API adapter while the additive provider contract is finalized.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:screenshots
npm run build
```

Build output is written to `dist/`. Install `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` as an Obsidian-compatible plugin folder.

## Operating model

1. Enable specific project IDs in WikiSkill settings. Default is no consent.
2. Stream paged trace sources within the configured event budget, persisting an independent opaque cursor per source.
3. Correlate provider-authenticated terminal skill outcomes with their invocation evidence; a successful skill load alone is never evidence of task success.
4. Compile sanitized evidence into patterns, including counterexamples.
5. Run versioned Maintainer and Proposer jobs in background Agent Threads.
6. Evaluate baseline and candidate independently for every public and sealed holdout fixture through `constrainedRuns`, then validate JSON and grade locally.
7. Export a review packet. A human separately decides whether to change the canonical Playbook.

See [Architecture](docs/architecture.md) and [Security model](docs/security.md).
