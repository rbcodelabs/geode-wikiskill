# WikiSkill Evolution

WikiSkill is a desktop Geode/Obsidian-compatible plugin that examines vault activity for recurring friction, discovers installed skills, and prepares improvements for human review. Its knowledge and evaluation data belong to WikiSkill. Existing skills do not need extra manifests, test contracts, or changes to participate.

This work is based on [“WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution”](https://arxiv.org/abs/2608.27454) by Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan, and Tu Vu (arXiv:2608.27454). It adapts the paper's separation of experience, persistent knowledge, and executable skills to a vault plugin with human review.

## Getting started

For the published v0.1.1 release, install BRAT and add `rbcodelabs/geode-wikiskill` as a beta plugin, then enable WikiSkill Evolution. Local scans work independently; install Agent Threads v0.37.1 or later for conversation execution (v0.38.0 adds the local skill authoring workflow). Building from source remains available below.

1. Build the plugin and install `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` in your host's plugin directory. Enable WikiSkill Evolution.
2. Check WikiSkill settings: exclude folders you do not want scanned and add any skill directories outside the conventional installation locations.
3. Open the dashboard and scan the vault. WikiSkill discovers skills and reads a bounded batch of Markdown documents. Repeat scans advance through the vault and revisit changed documents.
4. Review the resulting friction patterns and their evidence. Vault findings are inferred from text, so a reported failure is not proof that a skill caused it.
5. With a compatible Agent Threads provider available, request a proposal. Review the suggested change and its verification status, then approve, dismiss, or defer it.
6. Export review material for a separate change to the skill's maintained source. Approval in WikiSkill does not edit or activate an installed skill.

Local scanning and skill discovery work without Agent Threads or any Agentic PM package. Agent Threads supplies optional execution evidence and the normal visible Agent Threads conversations used to author proposals and compare candidate behavior.

## Discovery and scanning

WikiSkill discovers conventional home and vault skill directories and accepts additional directories in settings. It reads skills as they are; collections with the same skill name remain distinct by source identity. Discovery does not install, update, or delete skills. Additional directories are useful when a host's configured sources are not exposed through a public API or conventional installation location.

Agent Threads v0.38.0 stores authored packages in the vault's `Skills` folder by default. WikiSkill discovers that folder automatically. If you customize it in Agent Threads, set the same vault-relative **Authored skills folder** in WikiSkill. Qualified `local:slug` attribution identifies the authored package; ambiguous unqualified names remain unresolved. Skill packages and their resources are excluded from friction scanning because instructions are not execution evidence.

For an approved local SKILL.md improvement with matching frontmatter, export includes an inert `skills_update_local` payload. It changes only SKILL.md and preserves omitted scripts, references and assets. A separately authorized agent or human must verify the source hash and matching configured local folder before executing it. Other sources receive ordinary review material for their maintained repository. WikiSkill never invokes local mutation tools itself.

Scanning is incremental and bounded. Folder exclusions are vault-relative paths, not glob patterns. WikiSkill excludes its own knowledge output and host configuration folders. Optional scheduled scanning runs every fifteen minutes; proposals are requested separately. Trace import requires consent for the relevant Agent Threads project IDs.

The default scan processes up to 100 files, with a 256 KiB file limit and a 1 MiB batch limit. The daily model budget reserves estimated tokens (50,000 by default), rather than enforcing a measured-token ceiling. There is no WikiSkill per-call dollar cap; normal host/provider limits apply, and actual usage can exceed the admission estimate. An evaluation uses two calls per scenario. Both files per scan and the daily reservation budget can be changed in settings; scheduled scanning is off by default.

The initial friction detector uses local text rules to find failure, correction, retry, and workaround signals. This can miss implicit frustrations or misinterpret quoted text. Inspect the supporting evidence before accepting a proposed explanation. Behavioral checks and source freshness checks are different: a proposal with no behavioral comparison remains unverified.

## Visible conversations

Proposal and comparison jobs appear as ordinary Agent Threads conversations. Use **Open thread** in WikiSkill's Jobs section to inspect messages or errors. WikiSkill does not open them automatically, switch your model, or require a separate API key. Failed attempts retain thread/run references; retries reconcile existing runs before sending another attempt. Threads use your host's normal effective workspace and permissions. Prompts request analysis only; applying an approved skill remains a separate action.

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

WikiSkill supports 1–10 cases and runs the original skill and candidate in separate visible conversations. These inherit normal host context, so comparisons are contextual rather than isolated. Grading compares the trimmed response to the expected text exactly. Choose cases where that narrow check is useful; it does not grade open-ended quality. Write the cases independently of the proposed answer. Results describe this sample only and do not establish general improvement. With no cases configured, the proposal remains unverified.

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
