# Security model

Vault text, traces, installed skill text, and model outputs are untrusted inputs. They can contain secrets, identifying information, incorrect claims, or prompt injection. A friction finding is evidence for review, not an instruction to execute.

## Reading and storage

- Users control excluded vault folders and additional skill directories. Trace import additionally requires project-ID consent.
- Discovery reads installed skills without modifying them. WikiSkill keeps its operational and evaluation data in its own storage.
- Scan work is bounded and excludes WikiSkill output and host configuration folders. Generated-output markers prevent exported notes from being recycled as new evidence.
- Configured redaction values are resolved through secret storage. Missing configured values must block processing rather than silently reduce redaction.
- Source references and content hashes support evidence inspection and stale-proposal checks.

## Execution and review

- Authoring and comparison runs use the Agent Threads constrained execution API. The provider must prevent access to host tools, filesystem, MCP servers, installed skills, and host settings. WikiSkill does not substitute an ordinary thread when constrained execution is unavailable.
- Local scanning does not require a model call. Model actions consume the configured budget.
- A successful source check is not a behavioral evaluation. Untested proposals remain explicitly unverified; comparison results apply only to their scenarios.
- Approval, dismissal, and deferral are review decisions. WikiSkill does not automatically modify or activate a skill or publish a repository change.
- Review exports contain proposal material and evidence references; they require inspection before being shared.

## Residual risks

Pattern matching cannot recognize every secret or identifying detail. Local friction rules can also misread quotations, negations, or unrelated events. Constrained execution limits access but does not establish that a model's proposal is correct. Human review and independent evaluation cases remain important when deciding whether to apply a proposed change.
