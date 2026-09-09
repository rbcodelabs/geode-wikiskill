# WikiSkill Evolution

WikiSkill is a desktop Geode/Obsidian-compatible plugin that examines vault activity for recurring friction, discovers installed skills, and prepares improvements for human review. Its knowledge and evaluation data belong to WikiSkill. Existing skills do not need extra manifests, test contracts, or changes to participate.

This work is based on [“WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution”](https://arxiv.org/abs/2608.27454) by Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan, and Tu Vu (arXiv:2608.27454). It adapts the paper's separation of experience, persistent knowledge, and executable skills to a vault plugin with human review.

## Getting started

1. Build the plugin and install `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` in your host's plugin directory. Enable WikiSkill Evolution.
2. Check WikiSkill settings: exclude folders you do not want scanned and add any skill directories outside the conventional installation locations.
3. Open the dashboard and scan the vault. WikiSkill discovers skills and reads a bounded batch of Markdown documents. Repeat scans advance through the vault and revisit changed documents.
4. Review the resulting friction patterns and their evidence. Vault findings are inferred from text, so a reported failure is not proof that a skill caused it.
5. With a compatible Agent Threads provider available, request a proposal. Review the suggested change and its verification status, then approve, dismiss, or defer it.
6. Export review material for a separate change to the skill's maintained source. Approval in WikiSkill does not edit or activate an installed skill.

Local scanning and skill discovery work without Agent Threads or any Agentic PM package. Agent Threads supplies optional execution evidence and the constrained model runs used to author proposals and compare candidate behavior.

## Discovery and scanning

WikiSkill discovers conventional home and vault skill directories and accepts additional directories in settings. It reads skills as they are; collections with the same skill name remain distinct by source identity. Discovery does not install, update, or delete skills. Additional directories are useful when a host's configured sources are not exposed through a public API or conventional installation location.

Scanning is incremental and bounded. Folder exclusions are vault-relative paths, not glob patterns. WikiSkill excludes its own knowledge output and host configuration folders. Optional scheduled scanning runs every fifteen minutes; proposals are requested separately. Trace import requires consent for the relevant Agent Threads project IDs.

The default scan processes up to 100 files, with a 256 KiB file limit and a 1 MiB batch limit. The daily model budget reserves estimated tokens (50,000 by default), rather than enforcing a measured-token ceiling. Each model call is capped at $0.10. An evaluation uses two calls per scenario. Both files per scan and the daily reservation budget can be changed in settings; scheduled scanning is off by default.

The initial friction detector uses local text rules to find failure, correction, retry, and workaround signals. This can miss implicit frustrations or misinterpret quoted text. Inspect the supporting evidence before accepting a proposed explanation. Behavioral checks and source freshness checks are different: a proposal with no behavioral comparison remains unverified.

## Comparing a proposal

Add independent scenarios in WikiSkill's scenario JSON setting. Each case has a unique ID, a prompt, and an expected response:

```json
[
  {
    "id": "missing-input",
    "prompt": "The required project identifier is missing. Respond with the next action only.",
    "expected": "Ask for the project identifier."
  }
]
```

WikiSkill supports 1–10 cases and runs the original skill and candidate separately. Grading compares the trimmed response to the expected text exactly. Choose cases where that narrow check is useful; it does not grade open-ended quality. Write the cases independently of the proposed answer. Results describe this sample only and do not establish general improvement. With no cases configured, the proposal remains unverified.

## Storage and review

Operational state lives in the plugin's `data.json`; explicit export writes knowledge and review artifacts beneath the configured output folder (default `Agent Knowledge/Skill Evolution`). WikiSkill keeps candidate text outside active skill roots. A changed or missing source skill must be reconciled before an old proposal can be approved.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:screenshots
npm run build
```

See [Architecture](docs/architecture.md) and [Security model](docs/security.md) for boundaries and limitations.
