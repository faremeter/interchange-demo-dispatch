# Dispatch as Deterministic TypeScript (PoC)

## What this spec is

Input to a prose-dispatch run. This document specifies the
`intx-dispatch` PoC: a deterministic TypeScript orchestrator
on top of `@intx/agent` that re-implements the `dispatch` skill.
The orchestrator owns the state machine; agents change run state
only by calling typed tools whose effects are validated,
persisted, and logged.

The bulleted task list under "What I'd build first" near the end
of this spec is the recommended starting DAG. Refine if
necessary, but do not re-derive from scratch — the
decomposition is sized for the implementer-tier model.

## Resolved design decisions

1. **Repo setup.** Sibling repo to `interchange`, path-linked. Lets
   us edit `@intx/agent`, `@intx/tools-posix`, and `@intx/tools-lsp`
   as we hit sharp edges during the PoC.
2. **Level model.** **Faithful to the prose.** One shared working
   tree per level. Every implementer at level N runs against the
   same `cwd`, with the path-escape middleware preventing it from
   touching anything outside that worktree. At fan-in, the
   orchestrator iterates tasks in topological order and, per task,
   runs `git add <filesModified>` + `git commit`. Shared-file
   attribution: when two tasks at the same level claim the same
   file, the later task in topological order owns it; earlier
   tasks' commits skip it. If a commit unit has zero files after
   attribution, skip the commit but still mark the task
   `committed` with `commitSHA: null` (explore tasks and
   stripped commit units need to enter the critique gate). No
   rebases, no merge conflicts. We accept the "agents may step on
   each other in the shared tree" risk; the unreported-modifications
   check below catches the worst case loudly.
3. **Phase 5.** Full prose Phase 5, encoded deterministically. See
   the enumeration section below. No knobs.
4. **Quality gates source.** Orchestrator reads a known set of
   files from the target repo (`AGENTS.md`, `CONVENTIONS.md`,
   `README.md`, every `skills/*/SKILL.md` except `dispatch`) at
   run start and bakes the concatenated content into the planner's
   and critics' seed messages. Dispatch's own prose skill is
   deliberately excluded — the orchestrator is the dispatch skill
   in code; re-reading the prose version risks the planner trying
   to follow phases the orchestrator already enforces. The
   planner has no `readSkill` tool; everything it needs is in the
   seed.
5. **Review machinery.** Karen-style processing of task-reported
   deviations is encoded as a deterministic policy in the
   orchestrator (severity threshold → accept / mark-failed /
   escalate / consult). Greybeard is encoded as a separate agent
   role, spawned by Karen only when the policy says "technical
   judgment needed." See the Tool surfaces section.

## Starting state and bootstrap

The prose dispatch is invoked inside a fresh, empty
`intx-dispatch/` directory, sibling to `interchange/`, with this
spec at `intx-dispatch/spec.md`. There is no source code, no
`package.json`, no build gate yet.

**Task 0 (bootstrap) is therefore the first level of the run, and
must run before baseline capture.** It produces:

- `package.json` declaring path-link dependencies on
  `../interchange/packages/agent`,
  `../interchange/packages/tools-posix`,
  `../interchange/packages/tools-lsp`, and
  `../interchange/packages/inference`.
- `tsconfig.json` (extends `../interchange/tsconfig.base.json`).
- `.gitignore` (`node_modules`, `dist`, `dispatch/`).
- `dispatch-config.yaml` with `buildGate: ["bun run lint",
  "bun run build", "bun run test"]` and the per-role
  `ModelConfig` block (every role defaults to
  `opencode-go/kimi-k2.6`).
- `bun install` so the workspace is wired and `tsc -b` runs
  green on an empty source tree.
- The empty source tree (`src/index.ts` exporting nothing).

The dispatch baseline is captured **after** Task 0 lands, not
before. A greenfield baseline of "no `package.json`" makes Phase
5's same-errors comparison meaningless; deferring the capture to
post-bootstrap gives a real baseline (empty project, all
commands exit 0).

## Definition of success

The PoC ships when it can run a smoke spec
(`examples/hello-world-spec.md`, describing a 3-task change
against `examples/fixtures/sample-target/`) end-to-end and
produce:

1. A `dispatch.yaml` matching what a human operator would have
   produced from the prose skill on the same spec.
2. Per-level worktrees with implementer agents constrained by
   tool surfaces that cannot touch the run manifest.
3. Per-task critique and level-gate critique with bounded
   amendment.
4. Per-task commits at fan-in, before the level gate runs.
5. Phase 5 verification against the baseline captured after
   Task 0, with the full attribution + fix + rebuild + re-critique
   engine.
6. Clean resume from any persisted state if interrupted.

The smoke spec and fixture target are part of the PoC and must
land before the run is declared done — they are how we
demonstrate the orchestrator works.

## Shape of the system

Four pieces.

### 1. State model

Everything the orchestrator cares about is in one persisted document
per run (yaml on disk is fine for PoC; one file is canonical, no
duplication into multiple yamls). Validated end-to-end with arktype.

Rough shape:

```ts
type Run = {
  name: string;
  specPath: string;
  targetRepoPath: string;
  integrationBranch: string;       // created by orchestrator
  baselineBuildLogPath: string;
  baselineFailures: BuildFailure[]; // parsed; "same failures" comparison
  commitStrategy: "per-task";      // locked
  status: RunStatus;
  // RunStatus = planning | gating-plan | executing | verifying
  //           | fixing-verification | consolidating | done | failed
  tasks: Task[];
  levelBoundaries: Record<number, string>; // level -> pre-level SHA
  gateVerdicts: GateVerdict[];
  verificationRounds: VerificationRound[]; // Phase 5 fix loop history
  createdAt: string;
};

type Task = {
  id: string;                      // "1a-extract_auth_module"
  level: number;
  sequence: string;                // "a", "b", ...
  dependsOn: string[];
  objective: string;
  planMarkdown: string;
  agentType: "intern" | "general" | "explore";
  class: "feature" | "bugfix";
  critiqueEnabled: boolean;
  verifyCommands: string[];
  status: TaskStatus;
  // TaskStatus = pending | running | submitted | critiquing
  //            | amend_requested | committed | fixing | completed | failed
  fixingSource: "critique" | "verification" | null;
  worktreePath: string | null;
  output: TaskOutput | null;       // includes filesModified[]
  commitSHA: string | null;        // current commit (re-set on rebuild)
  critiqueVerdicts: CritiqueVerdict[]; // appended per amendment round
  amendmentRoundsTotal: number;    // critique escalation counter
  verificationFixRoundsTotal: number; // verification escalation counter
};

type GateVerdict = {
  level: number;
  round: number;                   // 0 = initial gate, 1+ = post-amendment
  status: "pass" | "amend" | "fail";
  perTask: Record<string, { status: "pass" | "amend" | "fail";
                             findings: Finding[] }>;
};

type VerificationRound = {
  round: number;                   // 1-based
  finalBuildLogPath: string;
  newFailures: BuildFailure[];
  attribution: Record<string, string[]>; // taskId -> failure ids
  rebuildFromLevel: number | null;
  outcome: "pass" | "retry" | "escalated";
};

type Deviation = {
  id: string;                      // stable within the task
  severity: "minor" | "moderate" | "major";
  category: "scope" | "approach" | "missing-test"
          | "unreported-modification" | "other";
  description: string;
  affectedFiles: string[];         // may be empty
};

type TaskOutput = {
  summary: string;
  filesModified: string[];         // truthful; checked against worktree diff
  deviations: Deviation[];         // Karen processes this
  notes: string;
};
```

The orchestrator is the only writer of this file. Every state
transition is a single atomic write (write to tmp, rename). No agent
ever opens it.

### 2. Tool surfaces (per role)

Each agent role gets a `createToolRunner`-built runner with only the
tools it is allowed to call. This is the load-bearing design choice
in the PoC. Get this wrong and either agents cannot express what
they need, or they can express things that break invariants.

**Planner** — turns a spec into a DAG.

- `proposeTask({ idHint, level, dependsOn, objective, agentType,
    class, verifyCommands, critiqueEnabled })`
- `finalizePlan()` — terminal; runtime validates the DAG (acyclic,
  level numbers consistent with deps, every id unique) and writes
  the manifest. Refusal to finalize on validation failure is the
  signal back to the agent.

Planner has read tools (Read, Grep) for the target repo. It has no
write tools. The only way it changes the run is via `proposeTask` /
`finalizePlan`.

**Implementer** — runs one task in the shared level worktree.

- The standard work-tool surface comes from
  `@intx/tools-posix` (`createPosixTools({ cwd })` gives read-file
  / write-file / edit-file / grep / search-files / run-shell as a
  `ToolRunner` that plugs into `@intx/agent` via
  `fromToolRunner`) plus `@intx/tools-lsp`'s `createLSPPlugin`
  for in-tree diagnostics. The runner-level `cwd` validates the
  directory exists but **does not enforce path-escape** —
  `read-file.ts` calls `readFile(args.path, ...)` directly. We add
  a path-escape middleware (resolves `args.path` / `args.cwd`
  against the runner's configured cwd, rejects anything outside)
  via the existing `composeMiddleware` pipeline. ~50 lines.
- `recordBuildResult({ command, exitCode, stdoutTail })` — custom
  tool, repeatable, evidence for downstream phases.
- `submitOutput({ summary, filesModified, deviations, notes })`
  — custom terminal tool. `filesModified` is the truthful list of
  paths the agent changed (compared against the worktree's actual
  diff in Step 3a; mismatches fail the task). `deviations` is the
  list of declared departures from the plan, each with severity
  ("minor" | "moderate" | "major"); Karen processes it.

Implementer has no access to the run directory, no `git push` /
`git worktree` / `git config`, and no ability to commit. The
orchestrator owns all of those.

**Critic** (per-task).

- Read-only access to the task's worktree and its `output`.
- `recordVerdict({ taskId, status, findings })` — terminal.

**Gate critic** (per-level).

- Read-only access to all level-N task outputs and per-task
  critique verdicts.
- `recordGateVerdict({ level, status, perTask })` — terminal.

**Greybeard** (consulted by Karen on demand).

- Karen fires immediately after the implementer's `submitOutput`,
  before the level reaches fan-in / commit. Greybeard's
  read-only inputs at that point are: the task's `plan.md`, its
  `output.yaml`, and the specific deviation Karen is asking
  about. There is no committed diff yet — work lives in the
  shared worktree as uncommitted changes; greybeard can read the
  worktree directly (cwd-scoped, same as critics).
- `recordGreybeardVerdict({ taskId, deviationId,
    verdict: "accept" | "reject" | "escalate", rationale })` —
  terminal. `escalate` punts to the operator; the orchestrator
  does not consult greybeard recursively.

There is no Karen agent. Karen is a deterministic policy in the
orchestrator, applied to each `deviation` the implementer
reports: severity ≥ threshold → escalate to operator; severity <
threshold → consult greybeard (which then yields accept / reject
/ escalate). Encoded as a pure function, unit-testable.

The pattern is: every role has at most one terminal tool. The
orchestrator spawns the agent with a seed message (`plan.md` for
implementers, the spec for the planner, the relevant scratch for
critics), and waits until either the terminal tool is called or a
turn budget is exhausted.

**The terminal-tool pattern is not a primitive in `@intx/agent`.**
The runtime is built around `send` → reactor cycle → `connector.reply`
→ `SendResult`. A tool handler returns a `ToolResult` and the model
continues. To get "the agent halts when `submitOutput` is called,"
the terminal tool's handler resolves a Promise the orchestrator
awaits, then the orchestrator calls `close()` on the agent.

A small helper in `intx-dispatch/src/terminal-tool.ts` makes this
ergonomic:

```ts
function terminalTool<T>(
  name: string,
  schema: arktype.Type<T>,
): { tool: AgentTool; awaitTermination(): Promise<T> } {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  const tool: AgentTool = {
    definition: { name, schema },
    handler: async (call) => {
      const parsed = schema(call.args);
      if (parsed instanceof type.errors) {
        return { callId: call.id, content: parsed.summary, isError: true };
      }
      resolve(parsed);
      return { callId: call.id, content: "ok" };
    },
  };
  return { tool, awaitTermination: () => promise };
}
```

The orchestrator awaits `awaitTermination()` in parallel with the
agent's reactor loop. When the agent calls the terminal tool, the
Promise resolves with the validated arguments; the orchestrator
then `close()`s the agent.

**`@intx/agent`'s lock forces one agent per context directory.**
`packages/agent/src/lock.ts` rejects a second agent claiming the
same `contextDir`. Every implementer / critic / planner gets its
own `dispatch/<run>/<task>/agent-ctx/` directory. Sharing a context
across roles is illegal.

### 3. Orchestrator

Plain TypeScript. The skeleton:

```ts
async function runDispatch(spec: SpecRef) {
  const run = await initRun(spec);                  // captures baseline
  await plan(run);                                  // Phase 1 + 2
  for (const level of levelsOf(run)) {
    await runLevel(run, level);                     // implementers + Karen
    await commitLevel(run, level);                  // fan-in + attribution
    await gate(run, level);                         // critique + amendments
  }
  await verifyAgainstBaseline(run);                 // Phase 5, locked
  await reportFinal(run);
}
```

`runLevel` provisions the single level worktree (`git worktree
add` off the post-prior-level boundary) and fans implementers
out in parallel against that shared cwd. After each implementer
calls `submitOutput`, the orchestrator runs Karen's policy
synchronously on its `deviations[]`, consulting greybeard or
escalating to the operator before considering the task done.
`commitLevel` does the topological `git add` + commit with
shared-file attribution. `gate` runs per-task critique and the
level-gate critic; amendment is bounded at 3 rounds (notify at
round 3, ask user at round 4+).

### 4. Isolation

`@intx/agent` does not give worktree isolation for free, but
`@intx/tools-posix` and `@intx/tools-lsp` get us most of the way:
both take a `cwd`, both already plug into the agent runtime, and
`@intx/tools-lsp` has an explicit `worktree` option in
`createLSPPlugin`. What's missing is enforcement —
`runReadFile` doesn't validate `args.path` against the runner's
cwd, and `runShell` takes `cwd` from the agent's arguments. A
single middleware closes this gap.

PoC plan under the locked Option A (shared level worktree):

- One `git worktree add` per level, off the post-prior-level
  boundary, on a branch named for the run + level number.
  Branch-collision policy: if the branch exists from a prior
  interrupted run, the orchestrator reuses it after verifying
  its tip matches the persisted `levelBoundaries[level]`;
  otherwise the run fails loudly.
- Every implementer in that level gets
  `createPosixTools({ cwd: worktreePath })` + path-escape
  middleware + custom `recordBuildResult` and `submitOutput`
  tools. Implementers all share the worktree's filesystem but
  each gets its own `agent-ctx/` directory under
  `dispatch/<run>/<task>/agent-ctx/` (mandatory per `lock.ts`).
- `/tmp` is not policed by the cwd middleware. Concurrent agents
  share `/tmp`; we accept this for the PoC.
- Worktree teardown is the orchestrator's job (separate CLI verb,
  retained on success); agents cannot remove their own worktree
  (no `git worktree` capability in the tool surface).

`@intx/storage-isogit` is the in-memory option if real worktrees
get awkward, but for a PoC against real repos, real worktrees
match what an operator expects to see in `git worktree list`.

## Inference provider and per-role models

The PoC drives every agent through opencode-go. opencode-go
exposes an OpenAI-compatible API, so `@intx/inference`'s existing
`openai.ts` provider is reused — point it at opencode-go's
endpoint (base URL via config, API key via `OPENCODE_API_KEY`
env var, fail loudly if unset).

**Verify the existing `openai.ts` accepts a configurable
`baseURL`.** If it currently hardcodes `https://api.openai.com`,
add the config knob as a separate small task in
`@intx/inference` before any orchestrator work depends on it.
Path-linking means the change lands without a publish cycle.

Each agent role can be configured to a different model:

```ts
type ModelConfig = {
  planner: string;       // default: opencode-go/kimi-k2.6
  implementer: string;
  critic: string;
  gateCritic: string;
  greybeard: string;
  attribution: string;   // Phase 5 attribution agent
  fixAgent: string;      // Phase 5 fix agent
};
```

Every field defaults to `opencode-go/kimi-k2.6`. The structure
exists so an operator can swap in a different model per role
(e.g. drop the planner onto a stronger reasoning model, or move
implementers onto something cheaper) without code changes.

`ModelConfig` lives in a run-level config file
(`dispatch-config.yaml` in the target repo, or
`~/.config/dispatch/config.yaml` as a default). The orchestrator
constructs each agent's config separately, so per-role models
cost nothing structurally — just a field threaded through.

## Locked-in policies (no knobs)

These exist in the prose skill as "defaults the operator can
override." In the PoC they are constants. If we want to change one,
we change the code.

- **Commit strategy:** per-task. Phase 6 from the prose skill
  collapses to a no-op that just records the existing
  `commitSHA`s into the run report. The other prose strategies
  (`grouped`, `single`) are not implemented in the PoC.
- **Phase 5:** the full attribution + fix + rebuild + re-critique
  engine described in the enumeration below. Not a simple
  rerun-and-diff.
- **Amendment cap:** the prose skill notifies at round 3 and asks
  the operator at round 4+. PoC keeps those numbers. The round-4
  pause is the one operator-interactive escape hatch.
- **Critique enablement:** the planner proposes, but the runtime
  enforces: general agents always critiqued, intern agents
  critiqued by default, explore agents never critiqued. The agent
  cannot override.
- **Worktree retention:** worktrees survive a successful run for
  inspection and are torn down only on explicit operator command
  (separate CLI verb).

## Phase 5 enumeration (extracted from the prose skill)

Phase 5 is not "rerun the build and diff." It is a full
attribution + fix + rebuild + re-critique engine. Encoded
deterministically:

### Pre-check (Phase 4 boundary)

Before Phase 5 begins, two prose-skill checks run as part of
fan-in and need encoding:

- **Working-tree-clean precheck** (prose Phase 4 §start): the
  shared level worktree must be clean before a level starts;
  any uncommitted leftovers fail the run.
- **Unreported-modifications check** (prose Phase 4 §957): every
  file present in the worktree's diff that isn't claimed by some
  task's `filesModified` is a bug. Either the agent under-reported
  or a drive-by edit happened. Both are run failures.

### Empty-modifications skip

If `filesModified` is empty across every completed task at the
time Phase 5 begins, skip straight to Phase 7 (completion). No
build, no verification.

### Step 1 — Run the configured build gate

The **build gate** is whatever command the target tree uses to
verify itself — `make all` for the interchange repo, `cargo
test` for a Rust project, `npm run check` elsewhere. The
orchestrator does not invent it. It comes from the run's
`dispatch-config.yaml`:

```yaml
buildGate:
  - make all       # or however many commands, run in order
```

If `buildGate` is missing, the run fails loudly at init — there
is no auto-detection. The same gate is run at three points:
captured pre-Phase-1 as the baseline, run as each level's
per-task verify step (when a task's `verifyCommands` is the empty
array, it inherits the gate), and run here in Phase 5.

Save Phase 5 output to `dispatch/<run>/final-build.log`
(numbered per fix-loop round).

### Step 2 — Compare to baseline

Three outcomes:

| Baseline | Final | Action |
|---|---|---|
| Pass (exit 0) | Pass (exit 0) | Proceed to Phase 6 |
| Fail with same output | Fail with same output | No regression; Phase 6 |
| Anything else | Has new failures | Enter the fix loop (step 3) |

"Same output" is compared after normalization (strip ANSI,
timestamps, absolute paths under the worktree, `Time: Xms` style
noise, line-number noise from re-runs). The PoC starts with a
generic line-based normalizer; if it produces false positives in
practice we add tree-specific rules. There is no per-tool
structured parser — comparison is over the gate's full output
treated as text.

### Step 3 — Attribution

Spawn an attribution agent (general or explore role, read-only)
with a tool surface:

- `recordAttribution({ failureId, taskIds[] })` — repeated
- `finalizeAttribution()` — terminal

Input: `final-build.log`, `baseline-build.log`, per-task
`output.yaml` (which includes `filesModified` and `commitSHA`),
and `git show <commitSHA>` for each task. The agent's job is to
map each new failure to the responsible task(s). Persisted as
`failure-attribution.md` (free-form rationale) plus the structured
`attribution` map in `verificationRounds[N]`.

### Step 4 — Per-task fix phase (serialized)

For each task with attributed failures, in topological order:

1. Transition task status `committed` → `fixing`, set
   `fixingSource: "verification"`. Increment
   `verificationFixRoundsTotal`.
2. Reconstruct the task's worktree state at its original commit
   (the worktree may still exist; if not, recreate it from
   `commitSHA`).
3. Spawn a fix agent (same agentType as the original task) with:
   - The attributed failures
   - The task's `plan.md` (original objective)
   - `git show <commitSHA>` (the committed diff)
   - For cross-task interactions, the context from all
     co-attributed tasks
4. Fix agent's tool surface is the implementer surface **minus
   any git-mutating tools** — it edits files in the worktree but
   does not commit. The orchestrator rebuilds commits.
5. Fix agent calls `submitOutput`; orchestrator updates
   `filesModified` if new files were touched.
6. Re-run the task's `verifyCommands` (the per-task build gate).
   If still failing, the fix agent gets another turn; if it can't
   recover, the task transitions to `failed` and the whole run
   escalates.

### Step 5 — Rebuild commits from the earliest affected level

1. Find the earliest level containing an affected task.
2. `git reset --mixed <levelBoundaries[level]>` on the integration
   branch.
3. Re-create commits for every level from there forward, in the
   original topological order (same as the level's first fan-in):
   - **Recompute shared-file attribution from scratch** using the
     current `filesModified` lists and the attribute-to-last
     rule. A fix that changed a task's `filesModified` may have
     shifted who owns which file.
   - For each task in topological order: `git add` its attributed
     files (the subset of `filesModified` not owned by a later
     task at the same level), commit, record the new `commitSHA`,
     mark `committed`.
   - **Zero-file commit units:** if a task's attributed file set
     is empty (explore tasks, or a task whose files all migrated
     to a later sibling), skip the commit but still set
     `commitSHA: null` and mark `committed`. Downstream phases
     must tolerate a `null` SHA. (Confirms with prose Phase 4
     §986.)
4. After each level's commits land, update
   `levelBoundaries[level+1]` to the new HEAD. The order is:
   commit, then write the new boundary, then proceed. A crash
   between commit and boundary-write leaves a recoverable state
   (resume detects it from `git log`); the reverse order does not.

### Step 6 — Re-run critique on rebuilt levels

For every rebuilt level with `critiqueEnabled` tasks, run
per-task critique and the level gate again.

- **Critique passes everywhere:** go to step 7.
- **Critique finds blocking issues:** enter the nested
  critique-driven fix loop:
  1. Mark each affected task `fixing` with `fixingSource:
     "critique"`. Increment `amendmentRoundsTotal`.
  2. Spawn fix agents (no git mutation, same constraint as step
     4). Re-run per-task build gates.
  3. Restart step 5 from the earliest critique-failing level.
  4. Re-enter step 6.

Critique gates may also produce **`newTests`** — test files the
critic wants added to the task's diff. The prose skill (line
1079) folds these into the task's `filesModified` so the rebuild
picks them up. The PoC must do the same: a critique's
`recordVerdict` carries an optional `newTests: string[]` of paths
that will be appended to the responsible task's `filesModified`
before the next rebuild.

Two escalation counters, tracked independently per task:

- `amendmentRoundsTotal` — accumulates across normal execution and
  Phase 5 critique fixes
- `verificationFixRoundsTotal` — accumulates across Phase 5
  verification fix iterations

At round 3, the orchestrator surfaces a notification (logged, not
blocking). At round 4+, the run pauses for operator confirmation
before continuing. This is the one operator-interactive escape
hatch; everything else is deterministic.

### Step 7 — Re-verify

Re-run the full verification build. Compare to baseline using the
same rule as step 2.

- Matches baseline: exit Phase 5, proceed to Phase 6.
- New failures remain: append a new entry to
  `verificationRounds`, go back to step 3.

### Resume semantics

Phase 5 is the most fragile resume surface. The state needed:

- `verificationRounds[]` — every round's attribution, fix
  outcomes, and rebuild-from-level
- Per task: `status`, `fixingSource`, current `commitSHA`,
  `amendmentRoundsTotal`, `verificationFixRoundsTotal`
- `levelBoundaries` — must be current; never trust a stale value

The PoC must handle, at minimum, these interruption points (this
list is broader than the brief originally claimed):

- **Mid-task implementer agent.** Task is `running` with a
  `agent-ctx/` on disk; resume kills the stale agent context (per
  the `lock.ts` rule) and re-spawns from the seed message. No
  partial submitOutput is trusted.
- **Between submitOutput and state-file write.** The orchestrator
  writes state on every transition; if a crash happens after the
  agent's `submitOutput` handler resolves but before the file
  rename, the resume re-spawns the agent. We accept the wasted
  work for simplicity.
- **Fix-agent crashed with uncommitted changes in the worktree.**
  Task is `fixing`; worktree has a dirty diff that the agent
  never reported via `submitOutput`. Resume reverts the worktree
  to its `commitSHA` and re-spawns the fix agent.
- **Mid-rebuild (step 5), between commits within a level.** Some
  of a level's tasks have new `commitSHA`s and `committed`
  status; some still point at stale SHAs. Resume detects the
  inconsistency by walking `git log` from `levelBoundaries[level]`
  and resumes the rebuild from the first task whose `commitSHA`
  doesn't appear in the log.
- **Between commit and boundary write.** `commitSHA` is current
  but `levelBoundaries[level+1]` is stale or missing. Resume
  recomputes the boundary from `git log`.
- **Between baseline capture and Phase 1 start.** Run is in
  `planning` status with a baseline log on disk. Resume re-enters
  planning; no agent state to clean up.
- **Mid-Phase-5 fix loop, between verificationRounds entries.**
  A `final-build.log` exists for a round that never got a
  `VerificationRound` entry. Resume parses the orphan log,
  attaches it to the next round, restarts attribution.

The pattern: every interruption either re-runs a deterministic
step (no LLM cost) or re-runs at most one agent (one LLM cost).
No case is allowed to silently accept an inconsistent state.

### Build-output comparison — design note

Comparison is over the gate's full text output, normalized.
There is no per-tool structured parser. This means:

- The attribution agent (step 3) reads the diff between baseline
  and final output as text, alongside `filesModified` and
  committed diffs. It does the work of mapping output lines to
  responsible tasks — that's an LLM step, deterministic only in
  the sense that its output goes through a typed tool surface.
- If the normalizer produces false positives ("same output" but
  the comparison says different), the run enters the fix loop
  unnecessarily — costly but not incorrect. We add normalizer
  rules to catch the false-positive pattern.
- If the normalizer produces false negatives ("different output"
  but the comparison says same), a real regression slips through.
  This is the failure mode we care about. Mitigation: when the
  run reports "no regression," the operator-facing summary
  includes the diff for sanity-checking.

## What the PoC explicitly does not do

- No web UI. CLI only.
- No multi-run scheduling, no queueing, no daemonization.
- No provider abstraction beyond opencode-go. Anthropic / OpenAI
  / local-model adapters in `@intx/inference` are not used
  directly by the orchestrator — opencode-go is the single
  backend, and model selection happens via the model string.
- No fancy resume UX. If interrupted, re-running the CLI with the
  same run name picks up from the last persisted state. That is
  the whole resume story.
- No integration with the Claude Code harness. This is a
  standalone binary. It can be invoked from inside a Claude Code
  session, but it does not piggyback on Claude Code's `Agent`
  tool.

## Resolved policy decisions

- **Repo name.** `intx-dispatch`. Sibling to `interchange`,
  path-linked.
- **Provider backend.** opencode-go via the existing OpenAI-
  compatible adapter in `@intx/inference`. No new adapter.
- **Default model for every role.** `opencode-go/kimi-k2.6`.
  Operator overrides any role via `dispatch-config.yaml`. The
  per-role `ModelConfig` field is wired through but unused at
  the defaults level — every role just gets Kimi K2.6 unless
  overridden.
- **Karen severity policy.** Tiered: `major` → escalate to
  operator; `moderate` → consult greybeard; `minor` →
  auto-accept and log. Hardcoded; no operator knob.
- **Greybeard `escalate` verdict.** Pauses the run for operator
  input, same mechanism as the round-4 amendment escalation.
- **Spec format.** Free-form markdown. Planner parses it.
- **Target repo.** Always cwd. No `--repo` flag.
- **"Done" definition.** Run ends when the integration branch
  has all level commits and Phase 5 passes. Orchestrator never
  touches the operator's target branch (no auto-merge, no PR
  creation).
- **Failure surface.** Single-page markdown summary plus the
  persisted `dispatch.yaml`. No auto-preserved worktree
  (worktrees are already retained on failure by the worktree-
  retention policy).
- **Build gate.** Configured per target tree via
  `buildGate: [<commands>]` in `dispatch-config.yaml`. No
  auto-detection; no hardcoded parser set. Comparison is over
  normalized text output.

## What I'd build first

Recommended task DAG for the prose-dispatch planner. Refine as
needed, but the dependencies and ordering are load-bearing.

0. **Bootstrap.** Scaffold `package.json`, `tsconfig.json`,
   `.gitignore`, `dispatch-config.yaml`. Path-link
   `@intx/agent`, `@intx/tools-posix`, `@intx/tools-lsp`,
   `@intx/inference` from `../interchange/packages/*`. Empty
   `src/index.ts`. `bun install` + `bun run build` green. **The
   dispatch baseline is captured after this task lands, not
   before.**
1. **Verify `openai.ts` `baseURL` configurability.** If absent,
   add the knob in `@intx/inference/src/providers/openai.ts`.
   Verification: a unit test against a mock server at a non-
   OpenAI URL.
2. **State model + arktype validators + atomic persistence.** No
   agents yet. Drive a fake run by hand, exercise transitions in
   tests.
3. **Path-escape middleware for `@intx/tools-posix`.** ~50 lines,
   plugs into `composeMiddleware`. Test by writing an
   adversarial tool call that tries `../../etc/passwd` and
   confirming rejection.
4. **Skill-file loader.** Reads `AGENTS.md`, `CONVENTIONS.md`,
   `README.md`, and every `skills/*/SKILL.md` except `dispatch`
   from the target repo at run init, concatenates them into a
   single seed-text blob, persists path + bytes count to the
   run state for resume. Pure function; testable against a
   fixture repo.
5. **Terminal-tool helper.** Implement
   `terminalTool<T>(name, schema)` as specified in the Tool
   surfaces section.
6. **Implementer surface end-to-end.** `createPosixTools({ cwd })`
   + path-escape middleware + custom `submitOutput` terminal
   tool (using the helper from task 5). Drive one `@intx/agent`
   instance through a trivial task in a worktree, confirm
   `submitOutput` halts it.
7. **Planner surface + DAG validation.** Hand it a spec plus the
   skill-file blob, confirm the manifest is acyclic and levels
   are computed correctly.
8. **Critic + gate-critic surfaces.**
9. **Karen policy (deterministic) + greybeard agent.** Karen is
   a pure function with unit tests; greybeard is a small
   read-only agent role.
10. **Orchestrator loop, locked policies, Phase 5.** Bulk of the
    work.
11. **Resume.**
12. **Smoke spec + fixture target.** Write
    `examples/hello-world-spec.md` and the fixture repo at
    `examples/fixtures/sample-target/`. Run the orchestrator
    against the smoke spec end-to-end. This is the
    Definition-of-Success milestone; the PoC is not done until
    this passes.

Tasks 0–6 prove the design. If those work, the rest is plumbing
around the state machine.
