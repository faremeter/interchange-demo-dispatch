// Smoke tests for `interchange-demo-dispatch`.
//
// Three tests live here:
//
//   1. `planner-only smoke` — the original test (preserved). Drives only
//      `initRun` + `plan` against the fixture, asserts the planner emits a
//      valid 3-task DAG. Acts as a sanity check that the planner wire path
//      still works in isolation.
//
//   2. `runDispatch end-to-end smoke` — drives `runDispatch` against a
//      2-task / 2-level plan (L1 greet, L2 wire) through every agent role
//      (planner, implementer, critic, gate-critic) and Phase 5 verification
//      using the `@intx/inference-testing` deterministic harness. Asserts
//      the Definition-of-Success criteria the smoke can exercise
//      structurally:
//        DoS 1 — dispatch.yaml matches the expected DAG shape.
//        DoS 2 — per-level worktrees are provisioned and survive the run.
//        DoS 3 — per-task critic + level gate critic fire (bounded by their
//                first-pass `pass` verdicts; the amendment loop is not
//                stressed here).
//        DoS 4 — per-task commits land at fan-in before each level gate.
//        DoS 5 — Phase 5 verification runs against the captured baseline
//                via an injected `buildGateRunner` stub whose output matches
//                the baseline byte-for-byte. Asserts the run lands a single
//                `pass` verification round and transitions to `done`.
//
//      Scope reduction (per the task brief's allowance): this is a
//      narrowed option (a) — 2 levels of 1 task each, rather than the full
//      hello-world spec — chosen because the harness predicate API is
//      synchronous and cannot peek into a Request's body to distinguish
//      parallel implementer fetches by task id (the only field that
//      differentiates them). Restricting each level to a single task
//      removes parallelism so the registered matchers can be ordered by
//      observation order without ambiguity.
//
//      DoS 5 baseline rationale: the smoke writes a custom
//      `dispatch-config.yaml` into the temp work-dir whose `buildGate` is
//      a deterministic single `echo` command. That gives `initRun` a real
//      baseline log (captured via actual shell — `captureBaseline` runs
//      the configured commands) without needing `bun install` against the
//      fixture target. The Phase-5 build is then stubbed via
//      `buildGateRunner` so the final-build output matches baseline
//      verbatim and the normalizer reports no regression.
//
//   3. `runDispatch resume smoke` — exercises the `planning`-status
//      resume case (the only status `continueAfterResume` currently
//      supports — `executing`/`verifying`/`fixing-verification`/
//      `consolidating` resume is an explicit PoC gap). The test:
//        - Calls `initRun` once to materialise a fresh run-state.yaml
//          with `status: "planning"`, `tasks: []`, and a real baseline
//          captured from the deterministic config.
//        - Re-invokes `runDispatch` against the same run dir, passing an
//          instrumented wrapper around the production `resume` callback
//          from `src/orchestrator/resume.ts`.
//        - Asserts the resume hook was called exactly once, that the
//          baseline state (`baselineBuildLogPath`, `baselineFailures`)
//          captured by the first `initRun` survives unchanged, and that
//          the resumed run completes successfully (`status: "done"`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  setupHarness,
  wire,
  type Harness,
} from "@intx/inference-testing";

import { initRun } from "../src/orchestrator/init.js";
import { plan } from "../src/orchestrator/plan.js";
import { runDispatch } from "../src/orchestrator/index.js";
import type {
  BuildGateRunner,
  TaskVerifier,
} from "../src/orchestrator/index.js";
import { resume } from "../src/orchestrator/resume.js";
import { loadRun, type Run } from "../src/state/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = resolve(HERE, "fixtures", "sample-target");

interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runChild(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<ChildResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "smoke",
        GIT_AUTHOR_EMAIL: "smoke@example.com",
        GIT_COMMITTER_NAME: "smoke",
        GIT_COMMITTER_EMAIL: "smoke@example.com",
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveResult({
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const r = await runChild("git", args, cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// Stand up a fresh temp copy of the fixture target with the smoke spec
// copied in as `spec.md` and an (empty) `skills/` directory so the
// planner's loader is happy. Whether baseline capture runs at all is the
// caller's choice (driven by `skipBaseline` on the dispatch spec).
async function setupFixtureRepo(slug: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `intx-smoke-${slug}-`));
  await cp(FIXTURE_SRC, dir, { recursive: true });
  const smokeSpec = await readFile(resolve(HERE, "hello-world-spec.md"), "utf8");
  await writeFile(join(dir, "spec.md"), smokeSpec, "utf8");
  await mkdir(join(dir, "skills"), { recursive: true });

  await gitOrThrow(dir, ["init", "-q", "-b", "main"]);
  await gitOrThrow(dir, ["add", "."]);
  await gitOrThrow(dir, ["commit", "-q", "-m", "initial fixture state"]);
  return dir;
}

// Overwrite the fixture-copied `dispatch-config.yaml` with a
// deterministic minimal config. The default fixture config declares a
// `bun run lint && bun run build && bun run test` build gate, which
// `captureBaseline` would actually shell out to during `initRun` — and
// the fixture's package.json has no resolved `node_modules`, so that
// would fail and pollute the captured log with non-deterministic output.
// A single `echo` command produces a stable, hermetic baseline log that
// the Phase-5 `buildGateRunner` stub can mirror byte-for-byte.
async function writeDeterministicDispatchConfig(dir: string): Promise<void> {
  const body = [
    "buildGate:",
    "  - echo baseline-marker",
    "modelConfig:",
    "  planner: smoke/planner",
    "  implementer: smoke/implementer",
    "  critic: smoke/critic",
    "  gateCritic: smoke/gate-critic",
    "  greybeard: smoke/greybeard",
    "  attribution: smoke/attribution",
    "  fixAgent: smoke/fix-agent",
    "",
  ].join("\n");
  await writeFile(join(dir, "dispatch-config.yaml"), body, "utf8");
}

// Plan markdown body padded to clear the planner schema's 200-character
// minimum. Each task gets its own body so the persisted `plan.md` files
// are distinguishable.
function planBody(taskId: string, level: number, summary: string): string {
  return [
    `# Task ${taskId}`,
    "",
    "## Objective",
    summary,
    "",
    "## Approach",
    "Use the implementer's write_file / edit_file tools to land the declared",
    "files, then call submitOutput with the same paths in filesModified.",
    "",
    "## Verification",
    `Pass-through verification at level ${String(level)}; the smoke test only`,
    "asserts the planner emitted a valid DAG.",
    "",
    "## Notes",
    "Plan body padded to clear the planner schema's 200-character minimum.",
    "",
  ].join("\n");
}

// Build the four tool calls the canned planner response delivers in a
// single SSE stream. The order matters: proposals must precede the
// `finalizePlan` call (the proposeTask handler validates dependsOn against
// already-accepted proposals, and `finalizePlan` is terminal — it resolves
// the orchestrator's awaitFinalizedPlan promise and runDispatch closes the
// agent before any follow-up inference call can fire).
//
// `finalizePlan` requires `verificationMode` and
// `verificationModeRationale` since INTR-87's sibling work in commit
// 773ada0. The helper below provides a default pair used by every
// smoke test; individual tests can override `mode` to exercise the
// non-default Phase 5 behaviours.
function finalizePlanArgsJSON(
  mode:
    | "baseline-equality"
    | "no-new-failures"
    | "skip-comparison" = "baseline-equality",
): string {
  return JSON.stringify({
    verificationMode: mode,
    verificationModeRationale: `smoke test — ${mode}`,
  });
}

function buildPlannerToolCallsThreeTask(): {
  callId: string;
  name: string;
  argsJSON: string;
}[] {
  const greetArgs = {
    idHint: "greet",
    level: 1,
    dependsOn: [],
    objective: "Add greet(name) to src/greet.ts with a covering test",
    planMarkdown: planBody(
      "greet",
      1,
      "Add greet(name) returning `Hello, ${name}!` plus a test.",
    ),
    agentType: "general",
    class: "feature",
    verifyCommands: [],
    critiqueEnabled: true,
  };
  const formatArgs = {
    idHint: "format",
    level: 1,
    dependsOn: [],
    objective: "Add formatHello(name) to src/format.ts with a covering test",
    planMarkdown: planBody(
      "format",
      1,
      "Add formatHello(name) returning the upper-cased greeting plus a test.",
    ),
    agentType: "general",
    class: "feature",
    verifyCommands: [],
    critiqueEnabled: true,
  };
  const wireArgs = {
    idHint: "wire",
    level: 2,
    dependsOn: ["greet", "format"],
    objective:
      "Re-export greet and formatHello from src/index.ts; update README",
    planMarkdown: planBody(
      "wire",
      2,
      "Re-export greet + formatHello from src/index.ts and update README.md.",
    ),
    agentType: "general",
    class: "feature",
    verifyCommands: [],
    critiqueEnabled: true,
  };
  return [
    { callId: "call-propose-greet", name: "proposeTask", argsJSON: JSON.stringify(greetArgs) },
    { callId: "call-propose-format", name: "proposeTask", argsJSON: JSON.stringify(formatArgs) },
    { callId: "call-propose-wire", name: "proposeTask", argsJSON: JSON.stringify(wireArgs) },
    { callId: "call-finalize", name: "finalizePlan", argsJSON: finalizePlanArgsJSON() },
  ];
}

// Predicate that identifies any inference POST to `/chat/completions`.
// Every agent role (planner, implementer, critic, gate-critic) is wired
// to the same OpenAI-compatible endpoint, so the harness routes by
// registration order rather than by URL.
function isInferenceRequest(req: Request): boolean {
  if (req.method !== "POST") return false;
  return req.url.endsWith("/chat/completions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Walk the OpenAI request body's `tools` array and return the function
// names the planner advertised to the model. Defensive: every layer is
// shape-checked rather than asserted, so a future change to the request
// body surfaces here rather than silently producing an empty list.
function extractAdvertisedToolNames(body: unknown): string[] {
  if (!isRecord(body)) {
    throw new Error("expected the planner's request body to be a JSON object");
  }
  const tools = body["tools"];
  if (!Array.isArray(tools)) {
    throw new Error("expected the planner's request body to carry a tools array");
  }
  const names: string[] = [];
  for (const entry of tools) {
    if (!isRecord(entry)) continue;
    const fn = entry["function"];
    if (!isRecord(fn)) continue;
    const name = fn["name"];
    if (typeof name === "string") names.push(name);
  }
  return names;
}

interface ActiveContext {
  harness: Harness;
  workDir: string;
}

let active: ActiveContext | null = null;

beforeEach(() => {
  active = null;
});

afterEach(async () => {
  if (active !== null) {
    active.harness.dispose();
    await rm(active.workDir, { recursive: true, force: true });
    active = null;
  }
});

const SMOKE_TIMEOUT_MS = 60_000;

describe("interchange-demo-dispatch planner smoke", () => {
  test("planner produces a valid 3-task DAG via real proposeTask + finalizePlan calls", async () => {
    const harness = setupHarness();
    const workDir = await setupFixtureRepo("planner");
    active = { harness, workDir };

    // Wire the canned planner response. `replyOnce` creates a stream,
    // builds a complete OpenAI SSE response containing every tool call,
    // and registers a single-use matcher routing the next planner fetch
    // to it. The matcher fires at most once; if the reactor issues a
    // follow-up inference call (e.g. because finalizePlan didn't close
    // the agent in time) `harness.run()` will surface
    // UnmatchedFetchError.
    harness.scenario.replyOnce("openai", {
      toolCalls: buildPlannerToolCallsThreeTask(),
      predicate: isInferenceRequest,
    });

    const runName = "planner-smoke";
    const spec = {
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName,
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
      // Skip baseline capture: the planner-only smoke doesn't run Phase 5,
      // so there is no need to install + build the fixture's toolchain.
      skipBaseline: true,
    };

    const init = await initRun(spec);

    // Drive `plan(...)` through the harness. The planner agent calls
    // createAgent → runInference → harness.deps.fetch; the canned SSE
    // response routes through the OpenAI adapter and emits four
    // `inference.tool_call.end` events, which the agent's reactor
    // dispatches to the planner's proposeTask / finalizePlan handlers.
    const runDir = join(workDir, "dispatch", runName);
    const planPromise = plan(init.run, {
      config: init.config,
      baseURL: "https://opencode-go.test/v1",
      apiKey: "smoke-test-key",
      adapter: "openai",
      contextDirRoot: join(runDir, "agent-contexts"),
      runStatePath: init.runStatePath,
      taskDirRoot: runDir,
      deps: harness.deps,
    });

    // Drive the harness clock so the canned SSE chunks fire. Run
    // concurrently with the plan call: `plan` parks the planner's fetch
    // in the harness's waiting set first, then `harness.run()` services
    // every scheduled chunk and asserts quiescence at the end.
    await harness.run();
    const planned = await planPromise;

    expect(planned.tasks.length).toBe(3);
    const tasksById = new Map(planned.tasks.map((t) => [t.id, t]));
    const greet = tasksById.get("1a-greet");
    const format = tasksById.get("1b-format");
    const wireTask = tasksById.get("2a-wire");
    if (greet === undefined || format === undefined || wireTask === undefined) {
      throw new Error(
        `expected tasks 1a-greet, 1b-format, 2a-wire; got ${planned.tasks
          .map((t) => t.id)
          .join(", ")}`,
      );
    }
    expect(greet.level).toBe(1);
    expect(format.level).toBe(1);
    expect(wireTask.level).toBe(2);
    expect(greet.dependsOn).toEqual([]);
    expect(format.dependsOn).toEqual([]);
    expect([...wireTask.dependsOn].sort()).toEqual(["1a-greet", "1b-format"]);

    // The persisted run-state.yaml carries the same shape — the
    // canonical doc the orchestrator hands to downstream stages.
    const persisted = await loadRun(init.runStatePath);
    expect(persisted.tasks.length).toBe(3);
    expect(persisted.status).toBe("executing");
    expect(persisted.tasks.map((t) => t.id).sort()).toEqual([
      "1a-greet",
      "1b-format",
      "2a-wire",
    ]);

    // Every plan.md file the planner stage materialises lives under the
    // run directory, not inside any worktree.
    for (const task of planned.tasks) {
      const planMd = await readFile(
        join(runDir, task.id, "plan.md"),
        "utf8",
      );
      expect(planMd.length).toBeGreaterThanOrEqual(200);
    }

    // The matched request body should have advertised both proposeTask
    // and finalizePlan as available tools. This pins the contract: the
    // adapter forwarded the planner's tool list verbatim and the harness
    // routed against a real OpenAI-formatted request — not a stubbed
    // shape.
    const matchedRequest = harness.scenario.lastRequest();
    if (matchedRequest === undefined) {
      throw new Error("expected the planner's inference request to have been matched");
    }
    const body: unknown = await matchedRequest.json();
    const advertisedToolNames = extractAdvertisedToolNames(body);
    expect(advertisedToolNames).toContain("proposeTask");
    expect(advertisedToolNames).toContain("finalizePlan");
  }, SMOKE_TIMEOUT_MS);
});

// =====================================================================
// runDispatch end-to-end smoke
// =====================================================================
//
// Helpers below produce SSE byte sequences for each agent role and
// register them with the harness. Each helper wraps `replyOnce("openai",
// ...)` so the response is a single-turn OpenAI SSE stream carrying the
// requested tool calls.

// Two-task plan: L1 greet, L2 wire (depends on greet). The planner
// proposeTask calls match the same schema the three-task helper uses.
function buildPlannerToolCallsTwoTask(): {
  callId: string;
  name: string;
  argsJSON: string;
}[] {
  const greetArgs = {
    idHint: "greet",
    level: 1,
    dependsOn: [],
    objective: "Add greet(name) to src/greet.ts with a covering test",
    planMarkdown: planBody(
      "greet",
      1,
      "Add greet(name) returning `Hello, ${name}!` plus a test.",
    ),
    agentType: "general",
    class: "feature",
    verifyCommands: [],
    critiqueEnabled: true,
  };
  const wireArgs = {
    idHint: "wire",
    level: 2,
    dependsOn: ["greet"],
    objective:
      "Re-export greet from src/index.ts so callers see it next to hello",
    planMarkdown: planBody(
      "wire",
      2,
      "Re-export greet from src/index.ts so callers see it next to hello.",
    ),
    agentType: "general",
    class: "feature",
    verifyCommands: [],
    critiqueEnabled: true,
  };
  return [
    {
      callId: "call-propose-greet",
      name: "proposeTask",
      argsJSON: JSON.stringify(greetArgs),
    },
    {
      callId: "call-propose-wire",
      name: "proposeTask",
      argsJSON: JSON.stringify(wireArgs),
    },
    { callId: "call-finalize", name: "finalizePlan", argsJSON: finalizePlanArgsJSON() },
  ];
}

// Schedule a one-turn OpenAI SSE response carrying `toolCalls` on the
// harness's next inference fetch. `startAt` is the virtual time at which
// the first chunk fires; downstream chunks fire at sequential offsets.
// Returns the post-stream virtual close time so the caller can chain
// scheduling.
function registerScriptedTurn(
  harness: Harness,
  toolCalls: { callId: string; name: string; argsJSON: string }[],
  startAt: number,
): number {
  const stream = harness.scenario.createStream();
  const chunks = wire.completeResponse("openai", { toolCalls });
  stream.enqueueAll(chunks, { startAt });
  harness.scenario.whenRequestMatches(isInferenceRequest, stream);
  return startAt + chunks.length;
}

// Build an implementer turn: write the declared files and submit
// output. The agent runs the production posix `write_file` tool against
// its worktree (path-escape middleware confines the writes), then the
// `submitOutput` terminal tool resolves `awaitSubmitOutput` and the
// orchestrator closes the agent — preventing any follow-up inference
// fetch from reaching the harness.
function buildImplementerTurn(
  taskId: string,
  worktreePath: string,
  files: { relativePath: string; content: string }[],
): { callId: string; name: string; argsJSON: string }[] {
  const writeCalls = files.map((f, idx) => ({
    callId: `impl-${taskId}-write-${String(idx)}`,
    name: "write_file",
    argsJSON: JSON.stringify({
      path: join(worktreePath, f.relativePath),
      content: f.content,
    }),
  }));
  const submitArgs = {
    summary: `wrote ${String(files.length)} file(s) for ${taskId}`,
    filesModified: files.map((f) => f.relativePath),
    deviations: [],
    notes: "scripted implementer reply",
  };
  return [
    ...writeCalls,
    {
      callId: `impl-${taskId}-submit`,
      name: "submitOutput",
      argsJSON: JSON.stringify(submitArgs),
    },
  ];
}

function buildCriticTurn(taskId: string): {
  callId: string;
  name: string;
  argsJSON: string;
}[] {
  const verdictArgs = {
    taskId,
    status: "pass",
    findings: [],
    newTests: [],
  };
  return [
    {
      callId: `critic-${taskId}-verdict`,
      name: "recordVerdict",
      argsJSON: JSON.stringify(verdictArgs),
    },
  ];
}

function buildGateCriticTurn(
  level: number,
  taskIds: readonly string[],
): { callId: string; name: string; argsJSON: string }[] {
  const perTask: Record<string, { status: string; findings: never[] }> = {};
  for (const id of taskIds) {
    perTask[id] = { status: "pass", findings: [] };
  }
  const verdictArgs = {
    level,
    status: "pass",
    perTask,
  };
  return [
    {
      callId: `gate-critic-level-${String(level)}-verdict`,
      name: "recordGateVerdict",
      argsJSON: JSON.stringify(verdictArgs),
    },
  ];
}

const GREET_TS_SOURCE = [
  "export function greet(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
  "",
].join("\n");

const GREET_TEST_SOURCE = [
  `import { expect, test } from "bun:test";`,
  "",
  `import { greet } from "./greet.ts";`,
  "",
  `test("greet returns a hello phrase", () => {`,
  `  expect(greet("world")).toBe("Hello, world!");`,
  "});",
  "",
].join("\n");

const INDEX_REWIRED_SOURCE = [
  `export { greet } from "./greet.ts";`,
  "",
  `export function hello(): string {`,
  `  return "hello";`,
  "}",
  "",
].join("\n");

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

async function listCommitFiles(cwd: string, sha: string): Promise<string[]> {
  const r = await runChild(
    "git",
    ["show", "--name-only", "--format=", sha],
    cwd,
  );
  if (r.exitCode !== 0) {
    throw new Error(`git show ${sha} in ${cwd} failed: ${r.stderr}`);
  }
  return r.stdout.split("\n").filter((s) => s.length > 0);
}

async function listCommitsOnBranch(
  cwd: string,
  branchName: string,
): Promise<{ sha: string; subject: string }[]> {
  // The `--` is mandatory: integration / level branch names contain `/`
  // and shadow the on-disk `dispatch/<runName>/` directory, so git
  // refuses to disambiguate without an explicit revision/path separator.
  const r = await runChild(
    "git",
    ["log", "--format=%H%x09%s", branchName, "--"],
    cwd,
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `git log on ${branchName} in ${cwd} failed: ${r.stderr}`,
    );
  }
  const out: { sha: string; subject: string }[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.length === 0) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) continue;
    out.push({
      sha: line.slice(0, tabIdx),
      subject: line.slice(tabIdx + 1),
    });
  }
  return out;
}

describe("interchange-demo-dispatch runDispatch end-to-end", () => {
  test("drives planner + implementers + critics + gate critics + Phase 5 verification for a 2-level plan", async () => {
    const harness = setupHarness();
    const workDir = await setupFixtureRepo("dispatch");
    await writeDeterministicDispatchConfig(workDir);
    active = { harness, workDir };

    const runName = "dispatch-smoke";
    const runDir = join(workDir, "dispatch", runName);
    const l1WorktreePath = join(runDir, "worktrees", "level-1");
    const l2WorktreePath = join(runDir, "worktrees", "level-2");

    // Register every expected inference scenario ahead of time. The
    // harness routes parked fetches to the first non-consumed matcher
    // whose predicate accepts them; with a single-task-per-level shape
    // the observation order is deterministic, so a linear registration
    // is sound. The virtual-time offsets are bookkeeping for the
    // simulated stream's enqueue schedule — every chunk fires before
    // `harness.run()` returns.
    let cursor = 10;

    // (1) Planner turn — proposeTask × 2 + finalizePlan in one stream.
    cursor = registerScriptedTurn(
      harness,
      buildPlannerToolCallsTwoTask(),
      cursor,
    );

    // (2) L1 implementer (1a-greet) — writes greet.ts + greet.test.ts
    //     and submits output. Both writes are scripted as parallel
    //     tool calls in a single OpenAI SSE response; the agent
    //     dispatches them to the production posix write_file handler,
    //     which materialises the files inside the L1 worktree.
    cursor = registerScriptedTurn(
      harness,
      buildImplementerTurn("1a-greet", l1WorktreePath, [
        { relativePath: "src/greet.ts", content: GREET_TS_SOURCE },
        { relativePath: "src/greet.test.ts", content: GREET_TEST_SOURCE },
      ]),
      cursor + 10,
    );

    // (3) L1 critic — passes 1a-greet with no findings.
    cursor = registerScriptedTurn(
      harness,
      buildCriticTurn("1a-greet"),
      cursor + 10,
    );

    // (4) L1 gate critic — passes the level with one per-task entry.
    cursor = registerScriptedTurn(
      harness,
      buildGateCriticTurn(1, ["1a-greet"]),
      cursor + 10,
    );

    // (5) L2 implementer (2a-wire) — rewrites src/index.ts to re-export
    //     greet alongside the existing hello() function and submits.
    cursor = registerScriptedTurn(
      harness,
      buildImplementerTurn("2a-wire", l2WorktreePath, [
        { relativePath: "src/index.ts", content: INDEX_REWIRED_SOURCE },
      ]),
      cursor + 10,
    );

    // (6) L2 critic — passes 2a-wire.
    cursor = registerScriptedTurn(
      harness,
      buildCriticTurn("2a-wire"),
      cursor + 10,
    );

    // (7) L2 gate critic — passes the level.
    cursor = registerScriptedTurn(
      harness,
      buildGateCriticTurn(2, ["2a-wire"]),
      cursor + 10,
    );

    void cursor;

    const spec = {
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName,
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    };

    // Phase-5 build-gate stub for DoS 5: returns the captured baseline
    // log verbatim so the normalizer reports "no regression". The
    // baseline file is materialised by `initRun`'s call to
    // `captureBaseline` (against the deterministic dispatch-config), so
    // the read is deferred until the runner is actually invoked.
    const baselineLogPath = join(runDir, "baseline-build.log");
    const buildGateCalls: number[] = [];
    const buildGateRunner: BuildGateRunner = async () => {
      buildGateCalls.push(buildGateCalls.length + 1);
      const baseline = await readFile(baselineLogPath, "utf8");
      return { output: baseline, exitCode: 0 };
    };
    // `taskVerifier` is unused in the no-regression path (Phase 5
    // never enters the fix loop), but the orchestrator wires it
    // anyway and the production default tries to shell out — point it
    // at a stub that mirrors the build gate's success shape so a
    // future change that does invoke it surfaces deterministically.
    const taskVerifierCalls: number[] = [];
    const taskVerifier: TaskVerifier = async () => {
      taskVerifierCalls.push(taskVerifierCalls.length + 1);
      const baseline = await readFile(baselineLogPath, "utf8");
      return { ok: true, output: baseline };
    };

    // Drive runDispatch concurrently with `harness.run()`. The
    // orchestrator parks each agent's fetch in the waiting set; the
    // clock advances chunked SSE bytes through the matching streams;
    // the production reactors parse them and fire tool dispatches
    // (both terminal tools, which resolve the orchestrator's await
    // promises, and posix tools, which actually write files inside
    // the level worktrees).
    const dispatchPromise = runDispatch(spec, {
      provider: {
        baseURL: "https://opencode-go.test/v1",
        apiKey: "smoke-test-key",
        adapter: "openai",
      },
      deps: harness.deps,
      buildGateRunner,
      taskVerifier,
    });

    await harness.run();
    const finalRun = await dispatchPromise;

    // DoS 1 — the planner emitted the expected 2-task DAG and the
    // persisted state matches.
    expect(finalRun.tasks.length).toBe(2);
    const greet = finalRun.tasks.find((t) => t.id === "1a-greet");
    const wireTask = finalRun.tasks.find((t) => t.id === "2a-wire");
    if (greet === undefined || wireTask === undefined) {
      throw new Error(
        `expected tasks 1a-greet, 2a-wire; got ${finalRun.tasks
          .map((t) => t.id)
          .join(", ")}`,
      );
    }
    expect(greet.level).toBe(1);
    expect(wireTask.level).toBe(2);
    expect([...wireTask.dependsOn]).toEqual(["1a-greet"]);
    expect(finalRun.status).toBe("done");

    // DoS 2 — both level worktrees were provisioned and still exist
    // on disk (the orchestrator leaves worktrees in place per policy;
    // there is no automatic teardown).
    expect(await pathExists(l1WorktreePath)).toBe(true);
    expect(await pathExists(l2WorktreePath)).toBe(true);
    expect(greet.worktreePath).toBe(l1WorktreePath);
    expect(wireTask.worktreePath).toBe(l2WorktreePath);
    // The L2 worktree carries the wired index.ts; the L1 worktree
    // carries the greet sources without the wired index.
    const l2IndexContents = await readFile(
      join(l2WorktreePath, "src", "index.ts"),
      "utf8",
    );
    expect(l2IndexContents).toContain("export { greet }");
    const l1GreetContents = await readFile(
      join(l1WorktreePath, "src", "greet.ts"),
      "utf8",
    );
    expect(l1GreetContents).toContain("Hello, ");

    // DoS 3 — per-task critic verdicts and per-level gate verdicts
    // were recorded. The critique-verdict array lives on each task;
    // the gate-verdict array lives on the run.
    expect(greet.critiqueVerdicts.length).toBeGreaterThanOrEqual(1);
    expect(wireTask.critiqueVerdicts.length).toBeGreaterThanOrEqual(1);
    const lastGreetVerdict = greet.critiqueVerdicts[greet.critiqueVerdicts.length - 1];
    const lastWireVerdict = wireTask.critiqueVerdicts[wireTask.critiqueVerdicts.length - 1];
    if (lastGreetVerdict === undefined || lastWireVerdict === undefined) {
      throw new Error("expected non-empty critiqueVerdicts on both tasks");
    }
    expect(lastGreetVerdict.status).toBe("pass");
    expect(lastWireVerdict.status).toBe("pass");
    expect(finalRun.gateVerdicts.length).toBe(2);
    const levelsGated = finalRun.gateVerdicts.map((v) => v.level).sort();
    expect(levelsGated).toEqual([1, 2]);
    for (const verdict of finalRun.gateVerdicts) {
      expect(verdict.status).toBe("pass");
    }
    // Amendment counters never advanced — the gate passed on round 1
    // for every task, so the bounded amendment loop never ran.
    expect(greet.amendmentRoundsTotal).toBe(0);
    expect(wireTask.amendmentRoundsTotal).toBe(0);

    // DoS 4 — per-task commits landed at fan-in. Each task carries a
    // commitSHA and that SHA exists in the integration branch's
    // history. The fixture's commit conventions don't constrain the
    // subject line, but the message body should mention the task id.
    const greetCommitSHA = greet.commitSHA;
    const wireCommitSHA = wireTask.commitSHA;
    if (greetCommitSHA === null || wireCommitSHA === null) {
      throw new Error(
        `expected non-null commitSHA on both tasks; got greet=${String(greetCommitSHA)}, wire=${String(wireCommitSHA)}`,
      );
    }
    const integrationCommits = await listCommitsOnBranch(
      workDir,
      finalRun.integrationBranch,
    );
    // The integration branch carries the fixture's initial commit
    // plus one merge for each level's per-task commits. The
    // per-task commits themselves live on the level branches.
    const l1Commits = await listCommitsOnBranch(
      workDir,
      `dispatch/${runName}-level-1`,
    );
    const l2Commits = await listCommitsOnBranch(
      workDir,
      `dispatch/${runName}-level-2`,
    );
    const allCommitShas = new Set<string>();
    for (const c of [...integrationCommits, ...l1Commits, ...l2Commits]) {
      allCommitShas.add(c.sha);
    }
    expect(allCommitShas.has(greetCommitSHA)).toBe(true);
    expect(allCommitShas.has(wireCommitSHA)).toBe(true);
    // The commit's tree contains the implementer-written files for
    // each task. `git show --name-only` is the simplest cross-platform
    // way to enumerate the file list a commit introduced.
    const greetFiles = await listCommitFiles(workDir, greetCommitSHA);
    const wireFiles = await listCommitFiles(workDir, wireCommitSHA);
    expect(greetFiles).toEqual(
      expect.arrayContaining(["src/greet.ts", "src/greet.test.ts"]),
    );
    expect(wireFiles).toEqual(expect.arrayContaining(["src/index.ts"]));
    // The commit subjects come from `buildCommitMessage` in
    // commit-level.ts (first sentence of the task objective). They
    // don't include the task id, but the per-level branches' commit
    // logs let us assert that L1's per-task commits live on the L1
    // branch and L2's live on the L2 branch.
    const l1Shas = new Set(l1Commits.map((c) => c.sha));
    const l2Shas = new Set(l2Commits.map((c) => c.sha));
    expect(l1Shas.has(greetCommitSHA)).toBe(true);
    expect(l2Shas.has(wireCommitSHA)).toBe(true);

    // Cross-check: the persisted run-state on disk has the same shape
    // as the in-memory final Run the orchestrator returned.
    const persisted = await loadRun(
      join(runDir, "run-state.yaml"),
    );
    expect(persisted.status).toBe("done");
    expect(persisted.tasks.map((t) => t.id).sort()).toEqual([
      "1a-greet",
      "2a-wire",
    ]);

    // DoS 5 — Phase 5 verification ran against the captured baseline.
    // The `buildGateRunner` stub was invoked exactly once (the no-
    // regression path returns immediately after the first matching
    // build), and `taskVerifier` was never invoked (no fix loop ran).
    // The persisted run carries a single verification round with
    // outcome=pass and the baseline path the orchestrator captured.
    expect(buildGateCalls.length).toBe(1);
    expect(taskVerifierCalls.length).toBe(0);
    expect(finalRun.baselineBuildLogPath).toBe(baselineLogPath);
    expect(finalRun.baselineFailures).toEqual([]);
    expect(finalRun.verificationRounds.length).toBe(1);
    const verificationRound = finalRun.verificationRounds[0];
    if (verificationRound === undefined) {
      throw new Error("expected one verification round on the final run");
    }
    expect(verificationRound.outcome).toBe("pass");
    expect(verificationRound.newFailures).toEqual([]);
    expect(verificationRound.attribution).toEqual({});
    expect(verificationRound.rebuildFromLevel).toBeNull();
    // The Phase-5 engine writes a per-round `final-build.log-<round>`
    // artifact alongside the run-state. Confirm the no-regression run
    // emitted exactly the first round's log.
    expect(await pathExists(join(runDir, "final-build.log-1"))).toBe(true);
    expect(verificationRound.finalBuildLogPath).toBe(
      join(runDir, "final-build.log-1"),
    );

    // Sanity check that no stray inference fetch slipped past the
    // matchers — the `await harness.run()` above already throws
    // `UnmatchedFetchError` on quiescence if any fetch is parked
    // without a matcher, but the per-test directory listing helps
    // diagnose mid-run failures from the test output.
    const runDirListing = await readdir(runDir);
    expect(runDirListing).toContain("worktrees");
    expect(runDirListing).toContain("run-state.yaml");
    expect(runDirListing).toContain("baseline-build.log");
  }, SMOKE_TIMEOUT_MS);
});

// =====================================================================
// runDispatch resume smoke (DoS 6)
// =====================================================================
//
// Exercises the `planning`-status resume case. `initRun` is invoked
// once to set up the dispatch directory, integration branch, and
// run-state.yaml at status=planning with no tasks yet (a natural
// interruption point — the operator's process died after baseline
// capture but before the planner posted its first proposeTask call).
// `runDispatch` is then invoked against the same run dir; the
// orchestrator sees the existing run-state.yaml, calls the supplied
// resume hook, and routes back into the plan stage via
// `continueAfterResume`.

// Single-task plan: L1 greet only. Mirrors the two-task helper's
// schema but emits a single proposeTask before finalizePlan.
function buildPlannerToolCallsSingleTask(): {
  callId: string;
  name: string;
  argsJSON: string;
}[] {
  const greetArgs = {
    idHint: "greet",
    level: 1,
    dependsOn: [],
    objective: "Add greet(name) to src/greet.ts with a covering test",
    planMarkdown: planBody(
      "greet",
      1,
      "Add greet(name) returning `Hello, ${name}!` plus a test.",
    ),
    agentType: "general",
    class: "feature",
    verifyCommands: [],
    critiqueEnabled: true,
  };
  return [
    {
      callId: "call-propose-greet",
      name: "proposeTask",
      argsJSON: JSON.stringify(greetArgs),
    },
    { callId: "call-finalize", name: "finalizePlan", argsJSON: finalizePlanArgsJSON() },
  ];
}

describe("interchange-demo-dispatch runDispatch resume", () => {
  test("resumes a planning-status run, replays the forward path, and reaches done", async () => {
    const harness = setupHarness();
    const workDir = await setupFixtureRepo("resume");
    await writeDeterministicDispatchConfig(workDir);
    active = { harness, workDir };

    const runName = "resume-smoke";
    const runDir = join(workDir, "dispatch", runName);
    const l1WorktreePath = join(runDir, "worktrees", "level-1");

    const spec = {
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName,
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    };

    // Stage 1: materialise a fresh planning-state run on disk. After
    // this call, run-state.yaml exists with status=planning, tasks=[]
    // and the baseline log was captured against the deterministic
    // dispatch-config.
    const initialInit = await initRun(spec);
    expect(initialInit.run.status).toBe("planning");
    expect(initialInit.run.tasks).toEqual([]);
    const stagedBaselineLogPath = initialInit.run.baselineBuildLogPath;
    const stagedBaselineFailures = initialInit.run.baselineFailures;
    expect(stagedBaselineLogPath).toBe(join(runDir, "baseline-build.log"));
    expect(await pathExists(stagedBaselineLogPath)).toBe(true);

    // Stage 2: build the harness scenarios for the planner + a single
    // L1 task (1a-greet) and its critic/gate. The plan deliberately
    // emits exactly one task at one level — the bare minimum that
    // exercises the full forward path post-resume.
    let cursor = 10;
    cursor = registerScriptedTurn(
      harness,
      buildPlannerToolCallsSingleTask(),
      cursor,
    );
    cursor = registerScriptedTurn(
      harness,
      buildImplementerTurn("1a-greet", l1WorktreePath, [
        { relativePath: "src/greet.ts", content: GREET_TS_SOURCE },
        { relativePath: "src/greet.test.ts", content: GREET_TEST_SOURCE },
      ]),
      cursor + 10,
    );
    cursor = registerScriptedTurn(
      harness,
      buildCriticTurn("1a-greet"),
      cursor + 10,
    );
    cursor = registerScriptedTurn(
      harness,
      buildGateCriticTurn(1, ["1a-greet"]),
      cursor + 10,
    );
    void cursor;

    // Stage 3: instrumented resume. Wraps the production `resume`
    // implementation (which classifies the interruption and returns
    // the normalised state) with a call counter so the test can
    // assert it was invoked exactly once. The classification path
    // here is case 6 (status=planning, tasks=[]); the wrapped
    // function is a pass-through, so the returned Run is the staged
    // state verbatim.
    let resumeCalls = 0;
    const resumeArgs: string[] = [];
    const resumedRuns: Run[] = [];
    const instrumentedResume = async (dir: string): Promise<Run> => {
      resumeCalls += 1;
      resumeArgs.push(dir);
      const r = await resume(dir);
      resumedRuns.push(r);
      return r;
    };

    // Stage 4: Phase-5 stubs identical in shape to the 2-level test.
    // The resumed run produces a single task with non-empty
    // `filesModified`, so Phase 5 will not short-circuit on the
    // empty-modifications check; the stub must return baseline-
    // matching output so the no-regression path fires.
    const buildGateRunner: BuildGateRunner = async () => {
      const baseline = await readFile(stagedBaselineLogPath, "utf8");
      return { output: baseline, exitCode: 0 };
    };
    const taskVerifier: TaskVerifier = async () => {
      const baseline = await readFile(stagedBaselineLogPath, "utf8");
      return { ok: true, output: baseline };
    };

    // Stage 5: re-invoke runDispatch. The orchestrator detects the
    // existing run-state.yaml, calls our instrumented resume hook,
    // routes into `continueAfterResume`, and runs the forward path
    // from the plan stage onward.
    const dispatchPromise = runDispatch(spec, {
      provider: {
        baseURL: "https://opencode-go.test/v1",
        apiKey: "smoke-test-key",
        adapter: "openai",
      },
      deps: harness.deps,
      resume: instrumentedResume,
      buildGateRunner,
      taskVerifier,
    });

    await harness.run();
    const finalRun = await dispatchPromise;

    // The resume hook fired exactly once with the canonical run
    // directory.
    expect(resumeCalls).toBe(1);
    expect(resumeArgs).toEqual([runDir]);

    // The hook's return value matched the staged planning state.
    expect(resumedRuns.length).toBe(1);
    const resumed = resumedRuns[0];
    if (resumed === undefined) throw new Error("expected resumed run");
    expect(resumed.status).toBe("planning");
    expect(resumed.tasks).toEqual([]);
    expect(resumed.baselineBuildLogPath).toBe(stagedBaselineLogPath);

    // `runDispatch` did NOT re-run `initRun` — the baseline state
    // captured by the original init survived the resume verbatim.
    expect(finalRun.baselineBuildLogPath).toBe(stagedBaselineLogPath);
    expect(finalRun.baselineFailures).toEqual(stagedBaselineFailures);
    expect(finalRun.createdAt).toBe(initialInit.run.createdAt);
    expect(finalRun.integrationBranch).toBe(initialInit.run.integrationBranch);

    // The resumed run completed.
    expect(finalRun.status).toBe("done");
    expect(finalRun.tasks.length).toBe(1);
    const onlyTask = finalRun.tasks[0];
    if (onlyTask === undefined) throw new Error("expected one task on resumed run");
    expect(onlyTask.id).toBe("1a-greet");
    expect(onlyTask.level).toBe(1);

    // The Phase-5 verification round landed `pass` (the resume
    // path's baseline is non-empty, so Phase 5 ran end-to-end).
    expect(finalRun.verificationRounds.length).toBe(1);
    const round = finalRun.verificationRounds[0];
    if (round === undefined) throw new Error("expected one verification round");
    expect(round.outcome).toBe("pass");

    // The persisted state matches the returned run.
    const persisted = await loadRun(join(runDir, "run-state.yaml"));
    expect(persisted.status).toBe("done");
    expect(persisted.baselineBuildLogPath).toBe(stagedBaselineLogPath);
  }, SMOKE_TIMEOUT_MS);
});
