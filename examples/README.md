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
  end-to-end against the fixture through the
  `@intx/inference-testing` deterministic harness.

## Running locally

```sh
bun test ./examples/smoke-test.ts
```

The test routes every inference call through the
`@intx/inference-testing` harness, so no model provider is contacted
and CI burns no inference budget. The full run takes roughly 20-30
seconds on a developer laptop, dominated by the `bun install` that
prepares each temp fixture's `node_modules`.

## How the harness drives the test

`runDispatch` exposes a single inference-boundary seam: a
`deps: Dependencies` option in `RunDispatchOptions` (see
`src/orchestrator/index.ts`). When `deps` is supplied, every spawned
agent threads that bundle into `@intx/agent`'s `createAgent`, so model
calls go through `harness.deps.fetch` instead of `globalThis.fetch`.

The smoke test wires this up in three steps:

1. **Setup.** `setupHarness()` from `@intx/inference-testing` returns
   a `{ scenario, deps, run, dispose }` bundle. `deps` is what gets
   passed into `runDispatch`; `scenario` is the registration API for
   canned responses.
2. **Register scenarios.** `scenario.replyOnce("openai", { toolCalls,
   predicate })` enqueues a one-shot OpenAI SSE response carrying the
   tool calls the next-matched fetch should see. Every agent role
   (planner, implementer, critic, gate critic) talks to the same
   `/chat/completions` endpoint, so the harness routes parked fetches
   to the first non-consumed matcher whose predicate accepts them —
   registration order is the routing order. The smoke test narrows
   the plan to one task per level so observation order is
   deterministic.
3. **Drive.** `runDispatch(spec, { provider, deps: harness.deps })`
   and `harness.run()` execute concurrently. The orchestrator parks
   each agent's fetch in the harness's waiting set; `harness.run()`
   services the scheduled SSE chunks and asserts quiescence at the
   end. Any parked fetch without a registered scenario surfaces as an
   `UnmatchedFetchError`.

The terminal-tool pattern (`submitOutput`, `finalizePlan`,
`recordVerdict`, `recordGateVerdict`) is what stops each agent: the
handler resolves a Promise the orchestrator awaits, the orchestrator
closes the agent, and no follow-up inference fetch reaches the
harness. Combined with `replyOnce`, each test turn fires exactly one
inference call and exactly one canned response.

## What the smoke test demonstrates

The smoke test in this directory asserts the structural
Definition-of-Success criteria the harness can exercise. It runs a
two-task / two-level narrowing of the hello-world spec (L1 `greet`,
L2 `wire` depending on `greet`) so the predicate-based scenario
routing remains deterministic.

- **DoS 1**: the planner's output (persisted at
  `<runDir>/run-state.yaml`, the canonical single-document state per
  spec.md §117) matches the expected DAG shape: two tasks across two
  levels, with the level-2 task depending on the level-1 task.
- **DoS 2**: per-level worktrees survived the run at
  `<runDir>/worktrees/level-<N>/`, and the run manifest
  (`<runDir>/run-state.yaml`) lives outside every worktree — the
  layout that `src/path-escape.ts`'s implementer-tool confinement
  enforces in production. The L1 worktree carries the implementer's
  `greet.ts`; the L2 worktree carries the re-wired `index.ts`.
- **DoS 3**: per-task critic verdicts AND level-gate critic verdicts
  both exist for every level. The scripted critics return `pass` on
  round 1, so the bounded amendment loop never fires;
  `task.amendmentRoundsTotal` stays at `0`.
- **DoS 4**: per-task commits land on each level's branch in
  topological order. The integration branch + per-level branches
  collectively contain every task's `commitSHA`, and L1's commit
  lives on `dispatch/<run>-level-1` while L2's lives on
  `dispatch/<run>-level-2`.

DoS 5 (Phase 5 verification against baseline) and DoS 6 (resume from
persisted state) are deferred. The rationale lives in
`smoke-test.ts`'s file header:

- DoS 5 requires a real baseline build of the fixture (`bun install`
  + the full build gate), which would blow the < 1-minute test budget
  and require network for first-run dependency resolution.
- DoS 6 requires a separate kill-and-resume harness run. The
  orchestrator's resume forward-path re-entry only handles `planning`
  / `gating-plan` statuses today (see `continueAfterResume` in
  `src/orchestrator/index.ts`); a meaningful resume test would need
  either orchestrator support for `executing` / `verifying` resume or
  a contrived planning-phase interruption.

A "planner-only" smoke also lives in the same file as a sanity check
that the planner wire path works in isolation — it drives only
`initRun` + `plan` against the fixture and asserts the planner emits
the full three-task DAG that `hello-world-spec.md` describes.

## PoC scope and known reductions

Following the brief and `spec.md` §87-§108:

- **No mutation testing / no `validate-fix` semantics.** The brief
  scopes the Phase 5 engine to "the full attribution + fix + rebuild
  + re-critique engine" and the critique loop to "bounded
  amendment." Neither mentions mutation-style validation of fixes
  against the new tests, and the PoC modules
  (`src/orchestrator/amendment-loop.ts`,
  `src/orchestrator/phase5/fix-phase.ts`) reflect that scope. The
  smoke test verifies the standard critique path; Phase 5 is
  exercised by `src/orchestrator/phase5/`'s own unit tests, not by
  the smoke test.
- **Harness-only inference in CI.** The full real-inference path
  goes through the `interchange-demo-dispatch` CLI with
  `OPENCODE_API_KEY` and a `provider` block in `dispatch-config.yaml`
  (see the repo-root README's `CLI` and `Configuration` sections).
  The smoke test never exercises that path; the harness is the
  load-bearing CI verification.

## Architectural observations

These orchestrator gaps were surfaced during the smoke run and remain
follow-ups. Each is real behaviour observed during the smoke; none
blocks the structural Definition-of-Success verification.

- **Amendment rebuild does not reset the worktree.** The amendment
  loop's `rebuildLevel` callback re-runs `commitLevel` against the
  same worktree without first resetting to the pre-level boundary.
  Tasks whose attributed files were not changed by the fix agent end
  up staging an empty index, and `git commit` refuses with "nothing
  to commit". A future smoke that exercises the amendment loop would
  need to wire the seeded mistake at a single-task level to avoid
  tripping this.
- **Amendment rebuild re-commits higher levels that have not run
  yet.** `rebuildLevel` filters `levelsOf(run).filter(l => l >=
  fromLevel)` and calls `commitLevel` on each. If amendment fires at
  level 1, the rebuild then attempts to commit level 2 — whose tasks
  have not been executed and have `output === null`, which
  `computeAttribution` refuses.
- **Resume forward-path re-entry is partial.** `continueAfterResume`
  in `src/orchestrator/index.ts` handles `planning` and `gating-plan`
  statuses but throws for `executing` / `verifying` /
  `fixing-verification` / `consolidating`. The on-disk consolidation
  pass (`src/orchestrator/resume/`) still runs and normalises the
  state file; what is missing is the forward-pass re-entry from the
  later statuses.
