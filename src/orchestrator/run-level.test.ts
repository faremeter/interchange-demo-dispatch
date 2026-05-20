// Integration tests for `runLevel`.
//
// The tests stand up a real fixture git repo, inject scripted-director-backed
// implementer spawners that drive the agent without HTTP, and verify the
// end-to-end behavior:
//
//   - The level worktree is provisioned.
//   - Implementer agents run in parallel and submit output.
//   - The run-state document is updated and re-persisted at each transition.
//   - The unreported-modifications check fires when an implementer writes a
//     file it did not declare in `filesModified`.
//   - Karen's loop wires into per-task processing, including the
//     consultGreybeard and operator-escalation paths.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentClosedError } from "@intx/agent";
import type {
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";

import { writeRun } from "../state/persist.js";
import { loadRun } from "../state/persist.js";
import type { Run, Task, TaskStatus } from "../state/types.js";
import {
  RunAbortedByOperatorError,
  UnreportedModificationsError,
  runLevel,
  type ImplementerAgentHandle,
} from "./run-level.js";
import type { GreybeardSpawner, OperatorResolver } from "./karen-loop.js";

function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolveResult({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

type ScriptStep =
  | { type: "executeTools"; calls: ToolCall[] }
  | { type: "done" };

function scriptedDirector(
  steps: ScriptStep[],
  onToolDone?: (result: ToolResult) => void,
): ReactorDirector {
  let cursor = 0;
  const nextOrDone = (caps: ReactorCapabilities) => {
    if (cursor < steps.length) {
      const step = steps[cursor++];
      if (step === undefined) return caps.done();
      if (step.type === "executeTools") return caps.executeTools(step.calls);
      return caps.done();
    }
    return caps.done();
  };
  return {
    async decide(
      event: ReactorInboundEvent,
      _state: ReactorState,
      caps: ReactorCapabilities,
    ) {
      switch (event.type) {
        case "message.received":
          return nextOrDone(caps);
        case "tool.done":
          if (onToolDone !== undefined) onToolDone(event.result);
          return nextOrDone(caps);
        case "abort":
          return caps.done();
        case "inference.done":
        case "inference.error":
        case "reactor.gate.cleared":
          return caps.done();
      }
    },
  };
}

function buildTask(over: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: over.id,
    level: over.level ?? 1,
    sequence: over.sequence ?? "a",
    dependsOn: over.dependsOn ?? [],
    objective: over.objective ?? "fixture task",
    planMarkdown: over.planMarkdown ?? `# Plan ${over.id}\n`,
    agentType: over.agentType ?? "general",
    class: over.class ?? "feature",
    critiqueEnabled: over.critiqueEnabled ?? true,
    verifyCommands: over.verifyCommands ?? [],
    status: over.status ?? "pending",
    fixingSource: over.fixingSource ?? null,
    worktreePath: over.worktreePath ?? null,
    output: over.output ?? null,
    commitSHA: over.commitSHA ?? null,
    critiqueVerdicts: over.critiqueVerdicts ?? [],
    amendmentRoundsTotal: over.amendmentRoundsTotal ?? 0,
    verificationFixRoundsTotal: over.verificationFixRoundsTotal ?? 0,
  };
}

function buildRun(name: string, tasks: Task[]): Run {
  return {
    name,
    specPath: "/dev/null",
    targetRepoPath: "/dev/null",
    integrationBranch: `integration-${name}`,
    baselineBuildLogPath: "/dev/null",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "executing",
    tasks,
    levelBoundaries: {},
    gateVerdicts: [],
    verificationRounds: [],
    createdAt: new Date().toISOString(),
  };
}

interface Harness {
  workRoot: string;
  repoRoot: string;
  runDir: string;
  runStatePath: string;
  runName: string;
}

async function makeHarness(runName: string): Promise<Harness> {
  const workRoot = await mkdtemp(join(tmpdir(), "intx-runlevel-"));
  const repoRoot = join(workRoot, "repo");
  const runDir = join(repoRoot, "dispatch", runName);
  const runStatePath = join(runDir, "run-state.yaml");

  await gitOrThrow(workRoot, ["init", "--initial-branch=main", "repo"]);
  await gitOrThrow(repoRoot, ["config", "user.email", "test@example.com"]);
  await gitOrThrow(repoRoot, ["config", "user.name", "test"]);
  await writeFile(join(repoRoot, "README.md"), "# fixture\n");
  await gitOrThrow(repoRoot, ["add", "README.md"]);
  await gitOrThrow(repoRoot, ["commit", "-m", "init"]);
  await gitOrThrow(repoRoot, ["branch", `integration-${runName}`]);
  await mkdir(runDir, { recursive: true });
  return { workRoot, repoRoot, runDir, runStatePath, runName };
}

const PROVIDER = {
  model: "claude-test",
  baseURL: "https://example.invalid",
  apiKey: "test-key",
} as const;

let harness: Harness;

beforeEach(async () => {
  harness = await makeHarness("test-run");
});

afterEach(async () => {
  await rm(harness.workRoot, { recursive: true, force: true });
});

function fakeAgent(closed: { value: boolean }): ImplementerAgentHandle {
  return {
    async send() {
      return { messages: [] };
    },
    async close() {
      closed.value = true;
    },
  };
}

describe("runLevel", () => {
  test("happy path: two implementers run in parallel, modify claimed files, and Karen passes", async () => {
    const tasks = [
      buildTask({ id: "t-a", sequence: "a" }),
      buildTask({ id: "t-b", sequence: "b" }),
    ];
    const run = buildRun(harness.runName, tasks);
    await writeRun(harness.runStatePath, run);

    const directorByTask: Record<string, ReactorDirector> = {
      "t-a": scriptedDirector([
        {
          type: "executeTools",
          calls: [
            {
              id: "c-write-a",
              name: "write_file",
              arguments: {
                path: "a.txt",
                content: "alpha\n",
              },
            },
          ],
        },
        {
          type: "executeTools",
          calls: [
            {
              id: "c-submit-a",
              name: "submitOutput",
              arguments: {
                summary: "wrote a.txt",
                filesModified: ["a.txt"],
                deviations: [],
                notes: "",
              },
            },
          ],
        },
      ]),
      "t-b": scriptedDirector([
        {
          type: "executeTools",
          calls: [
            {
              id: "c-write-b",
              name: "write_file",
              arguments: { path: "b.txt", content: "bravo\n" },
            },
          ],
        },
        {
          type: "executeTools",
          calls: [
            {
              id: "c-submit-b",
              name: "submitOutput",
              arguments: {
                summary: "wrote b.txt",
                filesModified: ["b.txt"],
                deviations: [],
                notes: "",
              },
            },
          ],
        },
      ]),
    };

    const result = await runLevel({
      run,
      level: 1,
      repoRoot: harness.repoRoot,
      runDir: harness.runDir,
      runStatePath: harness.runStatePath,
      ...PROVIDER,
      directorFactory: ({ task }) => {
        const d = directorByTask[task.id];
        if (d === undefined) throw new Error(`no director for ${task.id}`);
        return d;
      },
    });

    expect(result.run.tasks.find((t) => t.id === "t-a")?.status).toBe(
      "submitted",
    );
    expect(result.run.tasks.find((t) => t.id === "t-b")?.status).toBe(
      "submitted",
    );
    // Files were written to the worktree.
    const aContent = await readFile(join(result.worktreePath, "a.txt"), "utf8");
    const bContent = await readFile(join(result.worktreePath, "b.txt"), "utf8");
    expect(aContent).toBe("alpha\n");
    expect(bContent).toBe("bravo\n");
    // Persisted run-state matches the returned run.
    const reloaded = await loadRun(harness.runStatePath);
    expect(reloaded.tasks.map((t) => t.status).sort()).toEqual(
      (["submitted", "submitted"] as TaskStatus[]).sort(),
    );
  });

  test("unreported modification (file not claimed by any task) fails the level", async () => {
    const tasks = [buildTask({ id: "t-a", sequence: "a" })];
    const run = buildRun(harness.runName, tasks);
    await writeRun(harness.runStatePath, run);

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-write-claimed",
            name: "write_file",
            arguments: { path: "claimed.txt", content: "yes" },
          },
        ],
      },
      {
        type: "executeTools",
        calls: [
          {
            id: "c-write-stowaway",
            name: "write_file",
            arguments: { path: "stowaway.txt", content: "no" },
          },
        ],
      },
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit-a",
            name: "submitOutput",
            arguments: {
              summary: "claimed only one of two files",
              filesModified: ["claimed.txt"],
              deviations: [],
              notes: "",
            },
          },
        ],
      },
    ]);

    await expect(
      runLevel({
        run,
        level: 1,
        repoRoot: harness.repoRoot,
        runDir: harness.runDir,
        runStatePath: harness.runStatePath,
        ...PROVIDER,
        directorFactory: () => director,
      }),
    ).rejects.toBeInstanceOf(UnreportedModificationsError);
  });

  test("operator abort surfaces as RunAbortedByOperatorError", async () => {
    const tasks = [buildTask({ id: "t-a", sequence: "a" })];
    const run = buildRun(harness.runName, tasks);
    await writeRun(harness.runStatePath, run);

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-write-a",
            name: "write_file",
            arguments: { path: "a.txt", content: "alpha" },
          },
        ],
      },
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit",
            name: "submitOutput",
            arguments: {
              summary: "submitted with a major deviation",
              filesModified: ["a.txt"],
              deviations: [
                {
                  severity: "major",
                  category: "scope",
                  description: "out of scope work",
                  affectedFiles: ["a.txt"],
                },
              ],
              notes: "",
            },
          },
        ],
      },
    ]);

    const operatorResolver: OperatorResolver = async () => "abort";

    await expect(
      runLevel({
        run,
        level: 1,
        repoRoot: harness.repoRoot,
        runDir: harness.runDir,
        runStatePath: harness.runStatePath,
        ...PROVIDER,
        directorFactory: () => director,
        operatorResolver,
      }),
    ).rejects.toBeInstanceOf(RunAbortedByOperatorError);
  });

  test("moderate deviation triggers the injected greybeard spawner", async () => {
    const tasks = [buildTask({ id: "t-a", sequence: "a" })];
    const run = buildRun(harness.runName, tasks);
    await writeRun(harness.runStatePath, run);

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-write-a",
            name: "write_file",
            arguments: { path: "a.txt", content: "alpha" },
          },
        ],
      },
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit",
            name: "submitOutput",
            arguments: {
              summary: "submitted with a moderate deviation",
              filesModified: ["a.txt"],
              deviations: [
                {
                  severity: "moderate",
                  category: "scope",
                  description: "needs review",
                  affectedFiles: ["a.txt"],
                },
              ],
              notes: "",
            },
          },
        ],
      },
    ]);

    let spawnCount = 0;
    const greybeardSpawner: GreybeardSpawner = async (opts) => {
      spawnCount++;
      const closed = { value: false };
      return {
        agent: fakeAgent(closed),
        awaitVerdict: Promise.resolve({
          taskId: opts.taskId,
          deviationId: opts.deviation.id,
          verdict: "accept" as const,
          rationale: "ok",
        }),
      };
    };

    const result = await runLevel({
      run,
      level: 1,
      repoRoot: harness.repoRoot,
      runDir: harness.runDir,
      runStatePath: harness.runStatePath,
      ...PROVIDER,
      directorFactory: () => director,
      greybeardSpawner,
    });
    expect(spawnCount).toBe(1);
    expect(result.run.tasks[0]?.status).toBe("submitted");
  });

  test("scripted director that never reaches submitOutput surfaces a failure via the AgentClosedError race", async () => {
    // This test asserts the run-loop does not deadlock if the scripted
    // director returns done() without producing a submitOutput call. The
    // implementer's awaitSubmitOutput must reject with AgentClosedError, and
    // runLevel surfaces it directly.
    const tasks = [buildTask({ id: "t-a", sequence: "a" })];
    const run = buildRun(harness.runName, tasks);
    await writeRun(harness.runStatePath, run);

    const director = scriptedDirector([{ type: "done" }]);

    await expect(
      runLevel({
        run,
        level: 1,
        repoRoot: harness.repoRoot,
        runDir: harness.runDir,
        runStatePath: harness.runStatePath,
        ...PROVIDER,
        directorFactory: () => director,
      }),
    ).rejects.toBeInstanceOf(AgentClosedError);
  });
});
