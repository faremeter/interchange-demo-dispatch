# interchange-demo-dispatch

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

`interchange-demo-dispatch` is a different bet. It puts the orchestrator in plain
TypeScript code, gives every agent a typed tool interface, and persists
every state transition to disk as a YAML document validated against an
[arktype](https://arktype.io/) schema. Agents are still LLMs; the part
that decides who goes next, what they see, and what counts as "done" is
deterministic.

## What does it demonstrate?

The orchestrator drives a dispatch end-to-end against a fixture
project. The full pipeline:

1. **Plans** a multi-task change against the target by spawning a
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
   run started, in one of three modes chosen by the planner based on
   the spec: `baseline-equality` (output must match; refactors /
   migrations), `no-new-failures` (output may differ but no new parsed
   failures; bug fixes), or `skip-comparison` (baseline kept as a
   diagnostic record but not used as a gate; additive specs that add
   new tests / modules / binaries). When new failures do appear, an
   attribution agent maps them to responsible tasks, fix agents repair
   them, the affected commits are rebuilt, and critique re-runs — until
   either the build is clean or escalation triggers.
8. **Normalizes any of seven enumerated interruption points** on
   resume (mid-task crash, mid-rebuild, mid-Phase-5 fix loop, etc.)
   so a network blip or a kill-9 does not lose persisted state.
   Forward-path re-entry from `planning` / `gating-plan` is wired;
   re-entry from later statuses is a tracked follow-up — the resume
   pass still consolidates on-disk state but `runDispatch` halts
   before re-running the forward path.

The smoke test routes every inference call through the
`@intx/inference-testing` harness — `setupHarness()` returns a
`deps` bundle that the smoke test passes into `runDispatch` so model
calls go through `harness.deps.fetch` instead of `globalThis.fetch`.
Per-turn responses are scripted with `harness.scenario.replyOnce`,
which builds a complete OpenAI SSE stream for the tool calls the
test wants the agent to issue. CI burns no inference budget and the
test asserts structural properties of the resulting on-disk state,
git history, and persisted run document — see
[Testing](#testing) for the harness model in detail.

## A note on how this codebase was built

The orchestrator design in `spec.md` is a self-referential exercise:
this repository was constructed by a prose-based version of the same
orchestrator, running an 18-task DAG against this very spec. The
result is a working code version of the prose skill that built it.
Notes from that run live in `dispatch/interchange-demo-dispatch-poc/` (gitignored,
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
bun test ./examples/smoke-test.ts
```

The fixture target lives in `examples/fixtures/sample-target/`. The
smoke spec is `examples/hello-world-spec.md`. The smoke test routes
every inference call through the `@intx/inference-testing`
deterministic harness, so no model provider is contacted; it asserts
the structural Definition-of-Success criteria the harness can
exercise (DoS 1-4 in the two-level end-to-end test: planner DAG
shape, per-level worktrees, per-task + gate critique, fan-in commits)
plus DoS 5 (Phase 5 verification against a captured baseline, using
the orchestrator's `buildGateRunner` shell-execution boundary) and
DoS 6 (resume from a persisted `planning` state, asserting the
`resume` hook fires exactly once and the second `runDispatch` does
not re-run `initRun`).

The full repository test suite:

```sh
bun run lint
bun run build
bun run test
```

A real-inference run against a live opencode-go endpoint goes through
the `interchange-demo-dispatch` CLI in the target repository. Declare
a `provider` block in `dispatch-config.yaml` and export the bearer
credential:

```sh
OPENCODE_API_KEY=... interchange-demo-dispatch [run-name] [--skip-baseline] [--verbose]
```

`--verbose` opts into live streaming of the model's reasoning to
stderr; without it you get a one-line-per-turn summary. To wipe a
run from disk after aborting, `interchange-demo-dispatch clean <run-name>`.

See [Configuration](#configuration) for the `dispatch-config.yaml`
schema, [CLI](#cli) for the full verb / flag surface, and [Streaming
output](#streaming-output) for the trace format.

## CLI

`interchange-demo-dispatch` exposes three verbs (see `src/cli.ts`):

```
interchange-demo-dispatch [run-name] [--skip-baseline] [--verbose|-v]
    Run a dispatch against ./spec.md and ./dispatch-config.yaml in
    the current working directory. State lands under
    `<cwd>/dispatch/<run-name>/`. `run-name` defaults to a
    timestamp-derived identifier when omitted.

interchange-demo-dispatch teardown <run-name>
    Remove every per-level worktree associated with the named run.
    Does not delete the dispatch directory or its contents — the
    operator-inspectable `report.md` and `run-state.yaml` survive.

interchange-demo-dispatch clean <run-name>
interchange-demo-dispatch clean --all
    Wipe a run from disk in full: removes every per-level worktree,
    deletes every `dispatch/<run-name>/...` branch, and removes the
    `dispatch/<run-name>/` directory itself. Use after aborting a run
    when you want a clean slate. Idempotent and tolerant of partial
    state (corrupt run-state.yaml, dangling worktrees, stale branches).
    `--all` wipes every run in the current working directory's
    `dispatch/` and removes the `dispatch/` root if it ends up empty.
```

`--skip-baseline` hard-overrides baseline capture for greenfield
bootstraps where the build gate does not yet exist; Phase 5
short-circuits in that mode regardless of the planner's
`verificationMode` choice.

`--verbose` (or `-v`) switches the default stderr trace from one
summary line per turn to streaming the model's thinking and terminal
text line-by-line as they arrive (with 🧠 and 💬 markers
respectively) so the operator can watch reasoning appear in real
time. Tool calls and errors render identically in both modes. See
[Streaming output](#streaming-output) below for the on-the-wire
shape and the programmatic `trace` option.

## Streaming output

Every agent the orchestrator spawns drains its inference event
stream — `inference.error` payloads always reach stderr, and when
`RunDispatchOptions.trace` is wired the same drain forwards
human-readable lines for thinking, tool calls, and terminal text.
The CLI sets a stderr trace sink by default, so an operator running
the binary sees live progress without any setup:

```
[planner] → read_file(path="package.json")
[planner] thinking: I'll start by reading package.json to see what
  scripts and dependencies are already declared, then…
[planner] → proposeTask(idHint="install-arktype", level=1, …)
[implementer 1a-install-arktype] → write_file(path="package.json", …)
[implementer 1a-install-arktype] → run_shell(command="bun install")
[critic 1a-install-arktype round-1] → recordVerdict(status="pass", …)
[gate-critic level-1 round-1] → recordGateVerdict(status="pass", …)
```

stdout stays reserved for the report path the CLI prints at end.
Operators who want silence can pipe stderr to `/dev/null`; library
callers wire their own sink or omit it entirely (in which case only
the `inference.error → stderr` behaviour fires).

The `AgentTrace` type accepts either a bare `(line: string) => void`
or `{ write, verbose: true }` for the streaming mode the
`--verbose` flag wires up. See `src/agent-trace.ts` for the formatter
and `drainAgentStream` for the per-event handling.

## Configuration

`dispatch-config.yaml` lives in the target repository's root and
carries three blocks:

```yaml
buildGate:
  - bun run lint
  - bun run build
  - bun run test

modelConfig:
  planner: kimi-k2.6
  implementer: kimi-k2.6
  critic: kimi-k2.6
  gateCritic: kimi-k2.6
  greybeard: kimi-k2.6
  attribution: kimi-k2.6
  fixAgent: kimi-k2.6

provider:
  baseURL: https://opencode.ai/zen/go/v1
  adapter: openai
```

- `buildGate` — required, non-empty. The ordered shell commands the
  orchestrator captures as the baseline, inherits as each task's
  default `verifyCommands`, and re-runs in Phase 5.
- `modelConfig` — required. Per-role model string, threaded straight
  through to the inference call. Use the model identifier the endpoint
  expects (opencode-go accepts bare names like `kimi-k2.6`; some
  proxies require a vendor prefix).
- `provider` — optional. When present, both `baseURL` and `adapter`
  are required. `adapter` selects the inference HTTP API style:
  `"openai"` for OpenAI-compatible endpoints (including opencode-go),
  `"anthropic"` for the Anthropic API. The bearer credential comes
  from the `OPENCODE_API_KEY` env var; the CLI fails loudly when the
  block is declared but the env var is unset.

The planner additionally decides a **Phase 5 verification mode** as
part of finalizing the plan, persisted in `run-state.yaml` as
`Run.verificationMode`. Three values:

- `baseline-equality` — final build output must match the baseline
  byte-for-byte (modulo path / timestamp normalization). Pick for
  refactors / renames / migrations.
- `no-new-failures` — final output may differ but no new parsed
  failures may appear. Pick for bug fixes against a baseline with
  known-failing tests.
- `skip-comparison` — baseline captured for diagnostic record only;
  Phase 5 skips the equality check. Pick for additive specs (new
  modules, new CLI binaries, new tests).

The planner's system prompt teaches the choice from the spec's
verbs (`add` / `create` / `implement` → likely additive; `fix` /
`repair` → likely no-new-failures; `refactor` / `rename` /
`migrate` → likely baseline-equality). The CLI's `--skip-baseline`
flag is the operator override — when set, no baseline is captured
at all and Phase 5 is a no-op regardless of mode.

## Testing

`runDispatch` accepts an optional `deps: Dependencies` option in
`RunDispatchOptions` — the inference-layer dependency bundle (fetch,
clock, etc.) threaded straight through to every spawned agent. That
single seam is the supported way to drive a deterministic test.

The canonical example is `examples/smoke-test.ts`:

```ts
import { setupHarness, wire } from "@intx/inference-testing";

const harness = setupHarness();

// Pre-register every expected inference turn. Each call enqueues a
// one-shot OpenAI SSE response carrying the tool calls the test
// wants the next-fetched agent to issue.
harness.scenario.replyOnce("openai", {
  toolCalls: [
    { callId: "...", name: "proposeTask",   argsJSON: "..." },
    { callId: "...", name: "finalizePlan",  argsJSON: "{}" },
  ],
  predicate: (req) => req.method === "POST"
    && req.url.endsWith("/chat/completions"),
});

const dispatchPromise = runDispatch(spec, {
  provider: {
    baseURL: "https://opencode-go.test/v1",
    apiKey: "smoke-test-key",
    adapter: "openai",
  },
  deps: harness.deps,
});

// Service the scheduled SSE chunks against the parked fetches. The
// harness asserts quiescence at the end — every parked fetch must
// have matched a registered scenario.
await harness.run();
const finalRun = await dispatchPromise;
```

The harness is the **only** supported test seam for the inference
boundary. The orchestrator does not expose per-role agent factory
overrides; every agent role (planner, implementer, critic,
gate-critic, fix agent, attribution, greybeard) talks to the same
fetch instance, and the harness routes parked requests to registered
matchers in observation order.

`RunDispatchOptions` does still expose two non-inference seams for
operators retargeting the shell boundary:

- `buildGateRunner` — used by `verifyAgainstBaseline(...)` to run the
  configured build gate.
- `taskVerifier` — used to run per-task verification commands.

These are independent of the inference path and do not require the
harness.

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
  cli.ts           interchange-demo-dispatch binary (verbs: default = run;
                   teardown; clean).
  agent-trace.ts   AgentTrace contract + drainAgentStream — the shared
                   helper every spawn site uses to drain an agent's
                   inference event stream and forward formatted lines
                   to the operator-supplied trace sink.
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
  json-schema-fixup.ts
                   Stamps `type: "string"` onto enum-only JSON Schema
                   nodes so Moonshot-flavored validators (opencode-go's
                   kimi-k2.6) accept the arktype-emitted tool surface.
examples/          Smoke spec, fixture target, harness-driven smoke
                   test (`smoke-test.ts`).
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
- **Two HTTP adapters.** `provider.adapter` in `dispatch-config.yaml`
  selects `"openai"` (OpenAI-compatible endpoints, including
  opencode-go) or `"anthropic"` (the Anthropic API). Per-role model
  selection is configured in `dispatch-config.yaml`'s `modelConfig`
  block; there is no model-routing layer beyond the adapter + the
  per-role model string.
- **Limited resume coverage.** The resume pass classifies on-disk
  state into seven interruption cases and normalizes each. Forward-
  path re-entry from `planning` / `gating-plan` is wired; re-entry
  from later statuses (`executing`, `verifying`, `fixing-verification`,
  `consolidating`) throws with a clear error and the operator-facing
  workaround. The `clean` verb exists precisely so aborting + re-running
  is a one-command workflow until the rest of resume is wired.

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
