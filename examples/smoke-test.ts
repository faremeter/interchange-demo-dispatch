// Planner-only smoke test for `interchange-demo-dispatch`.
//
// Scope reduction: this is option (b) from the task brief — a planner-only
// smoke that exercises the real planner agent through the
// `@intx/inference-testing` deterministic harness and asserts Definition-of-
// Success criterion 1 (a valid DAG persisted to `run-state.yaml`). The
// remaining DoS criteria (worktrees, critique, per-task commits, Phase 5
// verification, resume) require scripting full multi-agent inference
// scenarios (planner + 5 implementers + critics + gate-critic + fix-agent)
// and are deferred to a follow-up task.
//
// What this test does NOT do:
//   - Call `runDispatch` (would require scripting every downstream agent).
//   - Use any agent-role override hooks (per the task brief's hard
//     constraints; the planner runs through `createPlannerAgent` against
//     the real OpenAI adapter wired to `harness.deps.fetch`).
//
// What this test DOES do:
//   - Builds a fixture target repo (the existing `sample-target/`).
//   - Registers one OpenAI-style wire scenario serving the planner's
//     `/chat/completions` POST with three `proposeTask` tool calls plus a
//     terminal `finalizePlan` call.
//   - Drives `initRun` + `plan` against the fixture.
//   - Asserts the produced `run-state.yaml` carries three tasks with the
//     expected level / dependsOn shape.
//   - Verifies `harness.run()` reaches quiescence with no unmatched fetches.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setupHarness, type Harness } from "@intx/inference-testing";

import { initRun } from "../src/orchestrator/init.js";
import { plan } from "../src/orchestrator/plan.js";
import { loadRun } from "../src/state/index.js";

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
// planner's loader is happy. Baseline capture is skipped because this
// smoke does not exercise Phase 5; that keeps the test independent of
// `bun install` and the fixture's build toolchain.
async function setupFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intx-smoke-planner-"));
  await cp(FIXTURE_SRC, dir, { recursive: true });
  const smokeSpec = await readFile(resolve(HERE, "hello-world-spec.md"), "utf8");
  await writeFile(join(dir, "spec.md"), smokeSpec, "utf8");
  await mkdir(join(dir, "skills"), { recursive: true });

  await gitOrThrow(dir, ["init", "-q", "-b", "main"]);
  await gitOrThrow(dir, ["add", "."]);
  await gitOrThrow(dir, ["commit", "-q", "-m", "initial fixture state"]);
  return dir;
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
function buildPlannerToolCalls(): {
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
    { callId: "call-finalize", name: "finalizePlan", argsJSON: "{}" },
  ];
}

// Predicate that identifies the planner's `/chat/completions` POST. The
// CreatePlannerAgent invocation below uses provider "openai" with a
// recognisable apiKey suffix; the harness routes any POST whose URL ends
// in `/chat/completions` to the canned response.
function isPlannerInferenceRequest(req: Request): boolean {
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
    const workDir = await setupFixtureRepo();
    active = { harness, workDir };

    // Wire the canned planner response. `replyOnce` creates a stream,
    // builds a complete OpenAI SSE response containing every tool call,
    // and registers a single-use matcher routing the next planner fetch
    // to it. The matcher fires at most once; if the reactor issues a
    // follow-up inference call (e.g. because finalizePlan didn't close
    // the agent in time) `harness.run()` will surface
    // UnmatchedFetchError.
    harness.scenario.replyOnce("openai", {
      toolCalls: buildPlannerToolCalls(),
      predicate: isPlannerInferenceRequest,
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
