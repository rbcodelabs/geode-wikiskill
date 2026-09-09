# Self-contained WikiSkill rebuild

Approved by the user on 2026-09-09 in the active conversation: discover installed skills, scan vault activity incrementally for friction, keep knowledge and evaluations within WikiSkill, and present proposals for human review without modifying target packages.

Implementation keeps the existing Agent Threads adapter, job queue, budgets and persistence. File discovery is read-only; configurable roots supplement conventional vault/home skill directories because the public Agent Threads API does not expose skill inventory. Scanning uses bounded local signal extraction with provenance and counterevidence. Proposals use Agent Threads when available; local discovery remains useful offline. Evaluation reports must distinguish checks from proof of improvement. Export is separate from review approval and never activates skills.

Done when synthetic non-PM evidence flows through discovery, incremental scanning, proposal review and export; exclusion, deletion, reload, stale hashes, budget and missing provider are covered. No Playbook contract or target is required. Merge and publication are out of scope.
