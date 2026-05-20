// Per-level gate-critic tool-surface tests.
//
// `buildGateCriticTools` is the deterministic surface the gate-critic
// agent exposes. We drive `ToolCall`s directly to keep every assertion
// inside this task's scope (the reactor itself is covered by
// `@intx/agent`'s suite).
//
// Coverage:
//   - Happy path: two clean tasks in scope -> gate verdict pass with
//     per-task pass.
//   - Amend path: one of two tasks has a blocking finding -> gate
//     verdict amend with per-task split.
//   - gitShow allowlist: in-allowlist SHAs reach the executor;
//     out-of-allowlist SHAs are rejected without invoking it.
//   - Read-only surface: only read_file / grep / search_files +
//     gitShow + recordGateVerdict are advertised.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import {
  buildGateCriticTools,
  type GateCriticVerdict,
  type GitExecutor,
  type PerTaskGateCriticInput,
} from "./gate-critic.js";

function asFullHandler(t: AgentTool) {
  if (t.kind !== "full") {
    throw new Error(
      `expected tool to be full-handler AgentTool, got kind=${t.kind}`,
    );
  }
  return t.handler;
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) {
    throw new Error(`expected tool "${name}" to be registered`);
  }
  return found;
}

function makeCall(
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}-1`,
): ToolCall {
  return { id, name, arguments: args };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

async function invoke(
  t: AgentTool,
  args: Record<string, unknown>,
  id?: string,
): Promise<ToolResult> {
  const handler = asFullHandler(t);
  return handler(makeCall(t.definition.name, args, id), neverAbort());
}

let workRoot: string;
let runDir: string;
let targetRepoPath: string;
let perTaskInputs: PerTaskGateCriticInput[];

const TASK_A_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TASK_B_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FORBIDDEN_SHA = "cccccccccccccccccccccccccccccccccccccccc";

async function writeTaskFiles(taskId: string): Promise<PerTaskGateCriticInput> {
  const dir = join(runDir, "tasks", taskId);
  await mkdir(dir, { recursive: true });

  const planPath = join(dir, "plan.md");
  await writeFile(planPath, `# ${taskId}\n\nObjective: do the thing.\n`, "utf8");

  const outputPath = join(dir, "output.yaml");
  await writeFile(
    outputPath,
    `status: completed\nsummary: ${taskId} done\nfilesModified: []\ndeviations: []\nnotes: ""\n`,
    "utf8",
  );

  const verdictPath = join(dir, "verdict.yaml");
  await writeFile(
    verdictPath,
    `taskId: ${taskId}\nstatus: pass\nfindings: []\n`,
    "utf8",
  );

  const sha = taskId === "task-a" ? TASK_A_SHA : TASK_B_SHA;
  return { taskId, planPath, outputPath, verdictPath, commitSHA: sha };
}

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "intx-gate-critic-test-"));
  runDir = join(workRoot, "run");
  targetRepoPath = join(workRoot, "repo");
  await mkdir(runDir, { recursive: true });
  await mkdir(targetRepoPath, { recursive: true });

  perTaskInputs = [
    await writeTaskFiles("task-a"),
    await writeTaskFiles("task-b"),
  ];
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("buildGateCriticTools", () => {
  test("happy path: both tasks clean -> gate verdict pass with per-task pass", async () => {
    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
    });

    const readFile = findTool(tools.agentTools, "read_file");
    const recordGateVerdict = findTool(tools.agentTools, "recordGateVerdict");

    // Sanity: the gate critic can read each task's verdict.yaml.
    const a = await invoke(readFile, { path: perTaskInputs[0]?.verdictPath });
    expect(a.isError).toBeUndefined();
    const b = await invoke(readFile, { path: perTaskInputs[1]?.verdictPath });
    expect(b.isError).toBeUndefined();

    const verdictArgs: GateCriticVerdict = {
      level: 1,
      status: "pass",
      perTask: {
        "task-a": { status: "pass", findings: [] },
        "task-b": { status: "pass", findings: [] },
      },
    };
    const res = await invoke(recordGateVerdict, verdictArgs);
    expect(res.isError).toBeUndefined();

    const resolved = await tools.awaitGateVerdict;
    expect(resolved).toEqual(verdictArgs);
  });

  test("amend path: one task blocking, the other clean", async () => {
    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
    });
    const recordGateVerdict = findTool(tools.agentTools, "recordGateVerdict");

    const verdictArgs: GateCriticVerdict = {
      level: 1,
      status: "amend",
      perTask: {
        "task-a": { status: "pass", findings: [] },
        "task-b": {
          status: "amend",
          findings: [
            {
              id: "g1",
              severity: "blocking",
              description: "task-b ships an obviously broken function",
              filePath: "src/broken.ts",
              lineRange: [3, 5],
            },
          ],
        },
      },
    };
    const res = await invoke(recordGateVerdict, verdictArgs);
    expect(res.isError).toBeUndefined();

    const resolved = await tools.awaitGateVerdict;
    expect(resolved.status).toBe("amend");
    expect(resolved.perTask["task-a"]?.status).toBe("pass");
    expect(resolved.perTask["task-b"]?.status).toBe("amend");
    expect(resolved.perTask["task-b"]?.findings.length).toBe(1);
  });

  test("gitShow accepts in-allowlist SHAs and forwards the executor's output", async () => {
    const captured: { sha?: string; cwd?: string } = {};
    const stubExecutor: GitExecutor = async (args) => {
      captured.sha = args.sha;
      captured.cwd = args.cwd;
      return {
        stdout: `commit ${args.sha}\nfake diff body\n`,
        stderr: "",
        exitCode: 0,
      };
    };

    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
      gitExecutor: stubExecutor,
    });
    const gitShow = findTool(tools.agentTools, "gitShow");

    const res = await invoke(gitShow, { sha: TASK_A_SHA });
    expect(res.isError).toBeUndefined();
    expect(captured.sha).toBe(TASK_A_SHA);
    expect(captured.cwd).toBe(targetRepoPath);
    if (typeof res.content === "string") {
      expect(res.content).toContain(`commit ${TASK_A_SHA}`);
      expect(res.content).toContain("fake diff body");
    }
  });

  test("gitShow rejects out-of-allowlist SHAs without invoking the executor", async () => {
    let executorCalls = 0;
    const stubExecutor: GitExecutor = async () => {
      executorCalls++;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
      gitExecutor: stubExecutor,
    });
    const gitShow = findTool(tools.agentTools, "gitShow");

    const res = await invoke(gitShow, { sha: FORBIDDEN_SHA });
    expect(res.isError).toBe(true);
    if (typeof res.content === "string") {
      expect(res.content).toMatch(/not in this level's allowlist/);
      expect(res.content).toContain(FORBIDDEN_SHA);
    }
    expect(executorCalls).toBe(0);
  });

  test("gitShow allowlist drops null commit SHAs (pre-commit tasks)", async () => {
    // Replace task-a's SHA with null and confirm task-a's old SHA is
    // no longer admitted, while task-b's remains.
    const taskA = perTaskInputs[0];
    const taskB = perTaskInputs[1];
    if (taskA === undefined || taskB === undefined) {
      throw new Error("perTaskInputs fixture invariant: two tasks expected");
    }
    const inputsWithNull: PerTaskGateCriticInput[] = [
      { ...taskA, commitSHA: null },
      taskB,
    ];

    let executorCalls = 0;
    const stubExecutor: GitExecutor = async () => {
      executorCalls++;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs: inputsWithNull,
      gitExecutor: stubExecutor,
    });
    const gitShow = findTool(tools.agentTools, "gitShow");

    const rejected = await invoke(gitShow, { sha: TASK_A_SHA });
    expect(rejected.isError).toBe(true);
    expect(executorCalls).toBe(0);

    const accepted = await invoke(gitShow, { sha: TASK_B_SHA });
    expect(accepted.isError).toBeUndefined();
    expect(executorCalls).toBe(1);
  });

  test("gitShow surfaces a non-zero exit code from the executor as isError", async () => {
    const stubExecutor: GitExecutor = async () => ({
      stdout: "",
      stderr: "fatal: bad object",
      exitCode: 128,
    });

    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
      gitExecutor: stubExecutor,
    });
    const gitShow = findTool(tools.agentTools, "gitShow");

    const res = await invoke(gitShow, { sha: TASK_A_SHA });
    expect(res.isError).toBe(true);
    if (typeof res.content === "string") {
      expect(res.content).toMatch(/exited 128/);
      expect(res.content).toMatch(/bad object/);
    }
  });

  test("recordGateVerdict with an invalid status is rejected and Promise stays unresolved", async () => {
    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
    });
    const recordGateVerdict = findTool(tools.agentTools, "recordGateVerdict");

    const res = await invoke(recordGateVerdict, {
      level: 1,
      status: "nope",
      perTask: {},
    });
    expect(res.isError).toBe(true);

    const sentinel = Symbol("pending");
    const race = await Promise.race([
      tools.awaitGateVerdict,
      new Promise<typeof sentinel>((r) =>
        setTimeout(() => {
          r(sentinel);
        }, 20),
      ),
    ]);
    expect(race).toBe(sentinel);
  });

  test("only read-side posix tools + gitShow + recordGateVerdict are advertised", () => {
    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
    });
    const advertised = tools.agentTools.map((t) => t.definition.name).sort();
    expect(advertised).toEqual(
      [
        "gitShow",
        "grep",
        "read_file",
        "recordGateVerdict",
        "search_files",
      ].sort(),
    );
  });

  test("path-escape: reading outside the run directory is rejected", async () => {
    const tools = buildGateCriticTools({
      runDir,
      targetRepoPath,
      perTaskInputs,
    });
    const readFile = findTool(tools.agentTools, "read_file");

    // targetRepoPath sits next to runDir; the path-escape middleware must
    // refuse reads through the read tool surface. The only way to inspect
    // the target repo is via gitShow.
    const outside = join(targetRepoPath, "any-file");
    const res = await invoke(readFile, { path: outside });
    expect(res.isError).toBe(true);
    if (typeof res.content === "string") {
      expect(res.content).toMatch(/outside the configured root/);
    }
  });
});
