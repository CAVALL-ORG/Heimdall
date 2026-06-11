## What & why

<!-- What does this PR change, and why? Link any issue. -->

## Invariant check (if you touched a skill or a tool)

- [ ] The agent still **never authors a SMILES** — every SMILES comes from
      `mcp__heimdall__export_smiles` (Ketcher) or the caller, never typed from
      vision/memory.

## Verify before merge (run locally — there is no CI)

```bash
cd server
npm run typecheck
npx vitest run tests/unit
npm audit --audit-level=moderate
# image-path smoke (needs Chromium):
RUN_KETCHER_E2E=1 npx vitest run tests/runtime-e2e/trimmed-server-smoke.e2e.test.ts --testTimeout=120000
```

- [ ] `npm run typecheck` clean
- [ ] `npx vitest run tests/unit` green (the 3 known paclitaxel dense-FP
      failures are pre-existing; no *new* failures)
- [ ] image-path smoke passes
- [ ] docs/tests updated for any behavior change
- [ ] change stays in scope (no unrelated refactors)
