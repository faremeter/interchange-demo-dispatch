# interchange-demo-dispatch examples

This directory holds the end-to-end smoke test for `interchange-demo-dispatch` —
the Definition-of-Success demonstration described in
`spec.md` §87-§108.

## Contents

- `hello-world-spec.md` — the smoke spec the orchestrator drives. A
  three-task change against the sample fixture: add `greet(name)`,
  add `formatHello(name)`, and wire both from the entry point.
- `fixtures/sample-target/` — a self-contained bun TypeScript
  project the smoke spec operates on. Has its own `package.json`,
  `tsconfig.json`, `dispatch-config.yaml`, source, and tests. The
  test setup helper initialises git inside a temp copy of this
  directory; the committed fixture deliberately does NOT carry a
  `.git/` to avoid nested-repository confusion (the parent repo's
  index would refuse, and embedded SHAs would need hand-maintenance
  every time the fixture changes).
- `smoke-test.ts` — the bun test runner that drives the orchestrator
  end-to-end against the fixture and asserts the six DoS criteria.

## Running locally

```sh
bun test ./examples/smoke-test.ts
```

The test runs in `--mock-inference` mode by default. Every external
collaborator (planner, implementer director, critic, gate critic,
fix agent, attribution agent, build gate, per-task verifier) is
injected as a scripted runner so CI can assert the structural
contract without contacting any model provider. The full run takes
roughly 20-30 seconds on a developer laptop, dominated by the
`bun install` that prepares each temp fixture's `node_modules`.

A `--real-inference` mode is reserved for an operator-on-demand
pass against a live opencode-go endpoint; it is not implemented in
`smoke-test.ts` yet. Hooking it up means supplying real
`OPENCODE_BASE_URL` / `OPENCODE_API_KEY` credentials, removing the
scripted runners, and either accepting non-deterministic test
output or capturing it for review. That work is intentionally
deferred — the structural assertions are the load-bearing
verification of the PoC.

## What the smoke test demonstrates

- **DoS 1**: the planner's output (persisted at
  `<runDir>/run-state.yaml`, the canonical single-document state per
  spec.md §117) matches the shape a human operator would have
  produced: three tasks across two levels, with the level-2 task
  depending on both level-1 tasks.
- **DoS 2**: per-level worktrees survived the run at
  `<runDir>/worktrees/level-<N>/`, and the run manifest
  (`<runDir>/run-state.yaml`) lives outside every worktree —
  the layout that `src/path-escape.ts`'s implementer-tool
  confinement enforces in production.
- **DoS 3**: per-task critique verdicts AND level-gate critique
  verdicts both exist for the seeded amendment round, and
  `task.amendmentRoundsTotal` is non-zero. The seeded mistake is a
  deliberately-broken `src/index.ts` at the level-2 wire task; the
  level-2 gate's round-1 critic flags it, the fix agent rewrites
  it, and round 2 passes.
- **DoS 4**: per-task commits land on each level's branch in
  topological order, and the level-2 task's commit timestamp is at
  or after every level-1 task's commit timestamp (the level-2 gate
  ran after both level-1 commits per spec §583).
- **DoS 5**: Phase 5 verification ran. `final-build.log-1` was
  written, compared against `baseline-build.log`, and
  `run.verificationRounds[0].outcome === "pass"`. The smoke test
  uses a build-gate runner that echoes the baseline log verbatim so
  Phase 5 cleanly short-circuits at "no regression" — the spec's
  documented clean-path outcome.
- **DoS 6**: after a clean run, the smoke test rewinds
  `run-state.yaml` to a mid-run interrupted state (task 0 in
  `running`, agent-ctx/ on disk, no `output.yaml`) and re-invokes
  `runDispatch` with `resume`. The orchestrator routes the
  recovered state through 7b-resume's case-1 detector, which removes
  the stale agent-ctx/ and demotes the task back to `pending` on
  disk. The forward-path re-entry from a non-terminal resume is
  documented as a known follow-up (see 7b's `dev-2` and the
  smoke-test inline comment); the DoS contract is "resume from any
  persisted state if interrupted", and the test asserts the
  consolidation took effect.

## PoC scope and known reductions

Following the brief and `spec.md` §87-§108:

- **No mutation testing / no `validate-fix` semantics.** The brief
  scopes the Phase 5 engine to "the full attribution + fix +
  rebuild + re-critique engine" and the critique loop to "bounded
  amendment." Neither mentions mutation-style validation of fixes
  against the new tests, and the PoC modules
  (`src/orchestrator/amendment-loop.ts`,
  `src/orchestrator/phase5/fix-phase.ts`) reflect that scope. The
  smoke test verifies the standard critique + Phase 5 paths.
- **Mock-inference only in CI.** The full real-inference path
  (`--real-inference`) is operator-on-demand and not yet
  implemented in this file. The scripted runners cover every
  collaborator the production wiring threads through
  `RunDispatchOptions`, so what CI verifies and what the real
  orchestrator runs share their shape; only the inference call
  itself is stubbed.

## Architectural observations

The smoke test surfaced several orchestrator gaps. These are real
behaviour observed during the smoke run; the orchestrator code
itself was deliberately left untouched per the task's hard
constraints. Each is reported as a major or moderate deviation in
`dispatch/interchange-demo-dispatch-poc/8a-smoke-spec/output.yaml`:

- **Amendment rebuild does not reset the worktree.** 7a's
  `rebuildLevel` callback re-runs `commitLevel` against the same
  worktree without first resetting to the pre-level boundary. Tasks
  whose attributed files were not changed by the fix agent end up
  staging an empty index, and `git commit` refuses with "nothing to
  commit". The smoke test works around this by wiring the seeded
  mistake at the LAST level (level 2), where the level has only one
  task and the rebuild's per-task commit is guaranteed to have a
  non-empty index.
- **Amendment rebuild re-commits higher levels that have not run
  yet.** 7a's `rebuildLevel` filters `levelsOf(run).filter(l => l >=
  fromLevel)` and calls `commitLevel` on each. If amendment fires
  at level 1, the rebuild then attempts to commit level 2 — whose
  tasks have not been executed and have `output === null`, which
  `computeAttribution` refuses. The level-2 amendment placement
  avoids this in the smoke test (there is no level 3).
- **Resume's forward-path re-entry is not yet wired.** When the
  resume callback returns a non-terminal `Run`, `runDispatch`
  throws "resume support is not wired (waiting on 7b-resume)". 7b's
  on-disk consolidation runs (case 1's agent-ctx cleanup is
  observable), but the orchestrator cannot resume the forward pass
  itself. The smoke test asserts the consolidation visibly took
  effect and that the throw points at the expected next-step
  message.

None of these block the PoC's structural Definition-of-Success
verification — the smoke test passes all six criteria with the
documented workarounds — but each is a real follow-up the operator
should triage.
