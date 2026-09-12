# Visible conversation execution — v0.1.1

User-approved correction: WikiSkill uses ordinary Agent Threads conversations and the user's existing authentication, provider and model. No separate Claude-only constrained executor or API key is required.

Threads are visible, non-ephemeral and non-background. WikiSkill sends analysis-only prompts, receives replies, persists thread/run references and offers an explicit Open thread action. Normal host context, workspace and permissions apply; prompt instructions are not isolation guarantees.

Baseline and candidate comparisons use separate normal conversations with independent exact-output cases, labelled contextual and limited. Admission budgets estimate token demand; host settings govern execution and no per-call WikiSkill dollar cap applies.

Versioned correlation keys and execution-mode markers separate legacy constrained jobs. Successful resumed runs are read without replay. Failed output validation permits a new message attempt in the same thread. Cancellation during creation prevents sending; timeout cancellation and errors preserve inspectable references.

Verification requires normal-only capabilities, visible flags/default inheritance, parsing, retry/reload/cancel paths, comparison conversation references, dashboard opening and actual disposable host integration. Applying skills remains a separately authorized action.
