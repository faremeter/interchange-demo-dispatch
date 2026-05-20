# intx-dispatch

A proof-of-concept orchestrator that coordinates multiple AI coding agents
working in parallel on the same codebase, with deterministic state, typed
handoffs, and automatic verification at every step.

## What problem is this solving?

Most AI coding tools today are a single agent in a chat window, doing one
task at a time. Building real software with AI assistance needs more than
that: many tasks, running in parallel, handing typed work products to each
other, with quality checks at the boundaries — basically, the work pattern
a small engineering team uses.

You can try to coordinate that through prose instructions ("now ask the
planner to..., then have the critic review..., then commit..."). It works,
but it's fragile: the same prompt produces different decisions on different
days; failure modes are silent; state lives in the model's head rather
than in a file you can inspect.

`intx-dispatch` is a different bet. It puts the orchestrator in plain
TypeScript code, gives every agent a typed tool interface, and persists
every state transition to disk as a YAML document validated against an
[arktype](https://arktype.io/) schema. Agents are still LLMs; the part
that decides who goes next, what they see, and what counts as "done" is
deterministic.

## What does it demonstrate?

A single command runs an end-to-end smoke test that:

1. **Plans** a three-task change against a fixture project by spawning a
   planner agent that reads a spec and emits a validated DAG.
2. **Provisions** a git worktree for each level of the DAG, isolated by a
   path-escape middleware so agents cannot read or write outside their
   sandbox.
3. **Runs implementer agents in parallel** at each level. Their tool
   surface is filesystem + a single terminal tool (`submitOutput`) — no
   git access, no network beyond the inference call.
4. **Applies a per-deviation policy** (the "Karen" pure function) to
   anything an agent reports as a deviation from its plan. Moderate
   deviations consult a "greybeard" agent for technical judgment; major
   ones escalate to the operator via a file the orchestrator polls.
5. **Commits each task** in topological order at the level fan-in, with
   shared-file attribution.
6. **Critiques the level** via a per-task critic and a level-gate critic.
   Blocking findings trigger a bounded amendment loop (three rounds
   silent, four-plus requires operator confirmation).
7. **Verifies the final build** against a baseline captured before the
   run started. If new failures appear, an attribution agent maps them
   to responsible tasks, fix agents repair them, the affected commits
   are rebuilt, and critique re-runs — until either the build is clean
   or escalation triggers.
8. **Resumes cleanly** from any of seven enumerated interruption points
   (mid-task crash, mid-rebuild, mid-Phase-5 fix loop, etc.) so a
   network blip or a kill-9 does not lose work.

The smoke test runs the whole pipeline with canned-response agents (so
CI does not burn inference budget) and asserts six structural
properties of the resulting on-disk state, git history, and persisted
run document.

## A note on how this codebase was built

The orchestrator design in `spec.md` is a self-referential exercise:
this repository was constructed by a prose-based version of the same
orchestrator, running an 18-task DAG against this very spec. The
result is a working code version of the prose skill that built it.
Notes from that run live in `dispatch/intx-dispatch-poc/` (gitignored,
present in the working copy for inspection).

The dispatch surfaced two real bugs in 5b (a branch-naming collision
and a `levelBoundaries` off-by-one) that the smoke test would have
hit; both were fixed upstream before the final commit. It also
surfaced two open issues in `runDispatch`'s rebuild semantics that
the smoke test works around for now; those are documented as
follow-ups.

## How to try it

```sh
bun install
bun test ./examples/smoke-test.ts -- --mock-inference
```

The fixture target lives in `examples/fixtures/sample-target/`. The
smoke spec is `examples/hello-world-spec.md`. The smoke test asserts
all six Definition-of-Success criteria from `spec.md` and prints the
per-criterion verdict.

The full repository test suite:

```sh
bun run lint
bun run build
bun run test
```

671 tests, all passing as of the latest commit.

A real-inference run against a live opencode-go endpoint is
operator-on-demand:

```sh
OPENCODE_API_KEY=... bun ./examples/smoke-test.ts -- --real-inference
```

## Where the code lives

```
src/
  agents/          Per-role agent factories (planner, implementer, critic,
                   gate-critic, greybeard) — each is an @intx/agent runtime
                   wired to a posix tool surface and exactly one terminal
                   tool.
  orchestrator/    The orchestrator's main loop and its constituent
                   stages: initRun, plan, runLevel, commitLevel, gate,
                   verifyAgainstBaseline (Phase 5), resume.
    phase5/        The attribution + fix + rebuild + re-critique engine
                   that drives the Phase 5 verification loop.
    resume/        Seven independent case handlers, one per interruption
                   point from spec.md §632-§677.
  state/           Persisted Run document — arktype schemas, atomic YAML
                   writes, single source of truth for the orchestrator.
  cli.ts           intx-dispatch binary (verbs: default = run; teardown).
  dag-validate.ts  Pure DAG validation used by both the planner agent
                   and resume.
  karen.ts         Deterministic policy: per-deviation severity → action.
                   No I/O.
  path-escape.ts   Filesystem middleware that prevents tool calls from
                   reading or writing outside the agent's configured root.
  skill-loader.ts  Bundles AGENTS.md, CONVENTIONS.md, README.md, and
                   skills/*/SKILL.md from the target repo into a single
                   seed blob for the planner and critics.
  terminal-tool.ts Helper that turns an @intx/agent tool call into a
                   Promise the orchestrator can await.
examples/          Smoke spec, fixture target, integration test.
tests/fixtures/    Per-module test fixtures.
spec.md            The brief that drove the build.
```

## What this is not

- **Not a finished product.** It is a proof-of-concept. The smoke spec
  is a single demonstration of plumbing that works end-to-end; it is
  not a general-purpose tool for production multi-agent workloads.
- **No mutation testing.** The dispatch skill's `validate-fix` extension
  is deliberately not implemented — the brief did not require it.
- **No web UI.** CLI only. The brief is explicit on this.
- **Single inference backend.** opencode-go via the OpenAI-compatible
  adapter in `@intx/inference`. Per-role model selection is configured
  in `dispatch-config.yaml`, but there is no provider abstraction
  beyond that.
- **Two open bugs in rebuild semantics.** Documented in `dispatch/
  intx-dispatch-poc/8a-smoke-spec/output.yaml`; the smoke test works
  around them by seeding amendments at a leaf level. Fixing them in
  `src/orchestrator/index.ts` and `src/orchestrator/commit-level.ts`
  is a tracked follow-up.

## Architecture sketch

```
                          spec.md
                             |
                             v
             +--------- runDispatch ---------+
             |                               |
             |   1. initRun                  |
             |      (config + baseline +     |
             |       integration branch)     |
             |                               |
             |   2. plan                     |
             |      (spawn planner agent;    |
             |       materialize DAG)        |
             |                               |
             |   3. for each level N:        |
             |        runLevel  ---->        |   per-level worktree;
             |          fan implementers     |   parallel implementer
             |          + Karen + greybeard  |   agents; submitOutput;
             |          + operator escape    |   path-escape middleware
             |          hatch                |
             |                               |
             |        commitLevel  --->      |   topological commits with
             |          shared-file          |   shared-file attribution;
             |          attribution          |   level boundary recorded
             |                               |
             |        gate  --->             |   per-task critic, level
             |          critic + amendment   |   gate critic, bounded
             |          loop (3/4+ caps)     |   amendment loop
             |                               |
             |   4. verifyAgainstBaseline    |
             |      (Phase 5: normalize +    |
             |       attribution agent +     |
             |       fix phase + rebuild +   |
             |       re-critique loop)       |
             |                               |
             |   5. writeFinalReport         |
             +-------------------------------+

State document persisted at every transition.
Resume picks up from any of seven interruption points.
```

## License

LGPL-2.1-only.
