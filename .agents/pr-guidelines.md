# Pull request guidelines

Before opening a pull request for WikiSkill Evolution:

- Run `npm run typecheck` and require zero TypeScript errors.
- Run `npm test` and require every Vitest unit/integration test to pass.
- Run `npm run test:screenshots`; regenerate with `npm run test:screenshots:update` only for intentional UI changes, then inspect the resulting image manually.
- Run `npm run build` and confirm `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` are present and non-empty.
- Run the Agentic PM Playbook validator: `node <playbook-root>/evals/integration-routing/scripts/validate-evaluation-contract.ts`. Require all fixtures and source-revision verification to pass.
- Compare `src/threads-contract.ts` with the pinned Agent Threads public API declaration whenever the provider contract changes.
- Review README and architecture/security documentation for changed behavior, privacy boundaries, operational limits, and known constraints.
- Run `git diff --check`, inspect the full diff, and manually verify the dashboard's dependency, import, pattern, candidate, evaluation, job, and review states.

Do not activate or promote a candidate automatically. A pull request must preserve isolated candidates and explicit human review.
