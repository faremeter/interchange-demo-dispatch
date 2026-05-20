// End-to-end integration test for `runDispatch`.
//
// The fixture sets up a real git repo with a spec.md + dispatch-
// config.yaml, then drives the full forward path through scripted
// overrides: a `plannerOverride` that hands back a two-task plan, a
// `directorFactory` that scripts each implementer to write its
// declared files, critic / gate-critic / fix-agent / attribution /
// build-gate / verifier runners that all return clean verdicts. The
// test asserts the final report path exists, the run-state document
// is `done`, and a commit per task lands on the level branch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolCall,
} from "@intx/types/runtime";

import { loadRun } from "../state/index.js";
import type { FinalizedPlan } from "../agents/planner-types.js";

import { runDispatch } from "./index.js";
import type {
  AttributionAgentRunner,
  BuildGateRunner,
  CriticRunner,
  FixAgentRunner,
  GateCriticRunner,
  Phase5FixAgentRunner,
  TaskVerifier,
} from "./index.js";

interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
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
  const r = await runGit(cwd, args);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

const VALID_CONFIG = `
buildGate:
  - echo build-ran
modelConfig:
  planner: opencode-go/kimi-k2.6
  implementer: opencode-go/kimi-k2.6
  critic: opencode-go/kimi-k2.6
  gateCritic: opencode-go/kimi-k2.6
  greybeard: opencode-go/kimi-k2.6
  attribution: opencode-go/kimi-k2.6
  fixAgent: opencode-go/kimi-k2.6
`;

let workDir: string;

async function setupFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intx-orch-loop-"));
  await gitOrThrow(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "# test\n", "utf8");
  await gitOrThrow(dir, ["add", "README.md"]);
  await gitOrThrow(dir, ["commit", "-q", "-m", "initial"]);
  await writeFile(join(dir, "spec.md"), "# spec\n\nDo things.\n", "utf8");
  await writeFile(join(dir, "dispatch-config.yaml"), VALID_CONFIG, "utf8");
  // The planner stage loads `<repo>/skills/`. An empty directory
  // satisfies the loader's "non-recursive readdir" without forcing
  // a real skill payload.
  await mkdir(join(dir, "skills"), { recursive: true });
  return dir;
}

beforeEach(async () => {
  workDir = await setupFixture();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function buildSingleTaskPlan(): FinalizedPlan {
  const full = buildTwoTaskPlan();
  const first = full.tasks[0];
  if (first === undefined) throw new Error("expected two-task plan to have at least one task");
  return { tasks: [first], levels: { alpha: 1 } };
}

function buildTwoTaskPlan(): FinalizedPlan {
  const longBody = (id: string, level: number): string =>
    [
      `# Task ${id}`,
      "",
      "## Objective",
      `Write a small fixture file owned by task ${id} at level ${String(level)}.`,
      "",
      "## Approach",
      "Use the implementer's write_file tool to put a short text body at the declared path.",
      "Submit with the declared file in filesModified and no deviations.",
      "",
      "## Verification",
      "Pass-through verification; the test asserts the commit lands and the report is rendered.",
      "",
      "## Notes",
      "This plan body is verbose only to satisfy the planner's 200-character minimum body length contract.",
      "",
    ].join("\n");

  return {
    tasks: [
      {
        idHint: "alpha",
        id: "alpha",
        level: 1,
        dependsOn: [],
        objective: "Write a fixture file owned by alpha",
        planMarkdown: longBody("alpha", 1),
        agentType: "general",
        class: "feature",
        verifyCommands: [],
        critiqueEnabled: true,
      },
      {
        idHint: "bravo",
        id: "bravo",
        level: 2,
        dependsOn: ["alpha"],
        objective: "Write a fixture file owned by bravo",
        planMarkdown: longBody("bravo", 2),
        agentType: "general",
        class: "feature",
        verifyCommands: [],
        critiqueEnabled: true,
      },
    ],
    levels: { alpha: 1, bravo: 2 },
  };
}

type ScriptStep =
  | { type: "executeTools"; calls: ToolCall[] }
  | { type: "done" };

function scriptedDirector(steps: ScriptStep[]): ReactorDirector {
  let cursor = 0;
  const advance = (caps: ReactorCapabilities) => {
    if (cursor >= steps.length) return caps.done();
    const step = steps[cursor++];
    if (step === undefined) return caps.done();
    if (step.type === "executeTools") return caps.executeTools(step.calls);
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
        case "tool.done":
          return advance(caps);
        case "abort":
        case "inference.done":
        case "inference.error":
        case "reactor.gate.cleared":
          return caps.done();
      }
    },
  };
}

function implementerScriptFor(filePath: string, content: string): ScriptStep[] {
  return [
    {
      type: "executeTools",
      calls: [
        {
          id: `write-${filePath}`,
          name: "write_file",
          arguments: { path: filePath, content },
        },
      ],
    },
    {
      type: "executeTools",
      calls: [
        {
          id: `submit-${filePath}`,
          name: "submitOutput",
          arguments: {
            summary: `wrote ${filePath}`,
            filesModified: [filePath],
            deviations: [],
            notes: "",
          },
        },
      ],
    },
  ];
}

const PASS_CRITIC: CriticRunner = async ({ round }) => ({
  round,
  status: "pass",
  findings: [],
  newTests: [],
});

const PASS_GATE_CRITIC: GateCriticRunner = async ({ level, round, perTaskVerdicts }) => {
  const perTask: Record<string, { status: "pass"; findings: never[] }> = {};
  for (const { taskId } of perTaskVerdicts) {
    perTask[taskId] = { status: "pass", findings: [] };
  }
  return { level, round, status: "pass", perTask };
};

const FAIL_FIX_AGENT: FixAgentRunner = async () => {
  throw new Error("fix agent should not run in the happy path");
};

const FAIL_PHASE5_FIX: Phase5FixAgentRunner = async () => {
  throw new Error("phase5 fix agent should not run in the happy path");
};

const FAIL_ATTRIBUTION: AttributionAgentRunner = async () => {
  throw new Error("attribution agent should not run when the build matches baseline");
};

function buildPassThroughBuildRunner(workDirRef: { current: string }): BuildGateRunner {
  return async ({ run }) => {
    // Echo the baseline log verbatim so `sameOutput` returns true
    // and Phase 5 short-circuits at the "no regression" branch.
    void run;
    const baselinePath = join(
      workDirRef.current,
      "dispatch",
      run.name,
      "baseline-build.log",
    );
    const text = await readFile(baselinePath, "utf8");
    return { output: text, exitCode: 0 };
  };
}

const PASS_VERIFIER: TaskVerifier = async () => ({ ok: true, output: "" });

describe("runDispatch", () => {
  test("end-to-end forward path completes and writes report.md", async () => {
    const spec = {
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "happy-run",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    };

    // The baseline log will be written by initRun before the build
    // gate runner is called. We override the build gate runner so the
    // Phase 5 invocation observes the same canonical text that the
    // baseline capture wrote (which is what the real PASS_BUILD
    // output matches).
    const finalRun = await runDispatch(spec, {
      plannerOverride: async () => buildTwoTaskPlan(),
      directorFactory: ({ task }) => {
        const map: Record<string, ScriptStep[]> = {
          "1a-alpha": implementerScriptFor("alpha.txt", "alpha-body\n"),
          "2a-bravo": implementerScriptFor("bravo.txt", "bravo-body\n"),
        };
        const script = map[task.id];
        if (script === undefined) {
          throw new Error(`no script for task ${task.id}`);
        }
        return scriptedDirector(script);
      },
      criticRunner: PASS_CRITIC,
      gateCriticRunner: PASS_GATE_CRITIC,
      fixAgentRunner: FAIL_FIX_AGENT,
      phase5FixAgentRunner: FAIL_PHASE5_FIX,
      attributionRunner: FAIL_ATTRIBUTION,
      buildGateRunner: buildPassThroughBuildRunner({ current: workDir }),
      taskVerifier: PASS_VERIFIER,
    });

    expect(finalRun.status).toBe("done");
    expect(finalRun.tasks.length).toBe(2);

    const reportPath = join(workDir, "dispatch", "happy-run", "report.md");
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("# Dispatch report: happy-run");
    expect(report).toContain("1a-alpha");
    expect(report).toContain("2a-bravo");

    const persisted = await loadRun(
      join(workDir, "dispatch", "happy-run", "run-state.yaml"),
    );
    expect(persisted.status).toBe("done");
    for (const task of persisted.tasks) {
      expect(task.status).toBe("completed");
      expect(task.commitSHA).not.toBeNull();
    }

    // Worktrees survive a successful run.
    const level1Worktree = join(
      workDir,
      "dispatch",
      "happy-run",
      "worktrees",
      "level-1",
    );
    const level2Worktree = join(
      workDir,
      "dispatch",
      "happy-run",
      "worktrees",
      "level-2",
    );
    const l1Stat = await stat(level1Worktree);
    const l2Stat = await stat(level2Worktree);
    expect(l1Stat.isDirectory()).toBe(true);
    expect(l2Stat.isDirectory()).toBe(true);
  });

  test("--skip-baseline path leaves baselineBuildLogPath empty and skips verification", async () => {
    const spec = {
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "skip-baseline-run",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
      skipBaseline: true,
    };

    const finalRun = await runDispatch(spec, {
      plannerOverride: async () => buildSingleTaskPlan(),
      directorFactory: () =>
        scriptedDirector(implementerScriptFor("alpha.txt", "alpha-body\n")),
      criticRunner: PASS_CRITIC,
      gateCriticRunner: PASS_GATE_CRITIC,
      fixAgentRunner: FAIL_FIX_AGENT,
      phase5FixAgentRunner: FAIL_PHASE5_FIX,
      attributionRunner: FAIL_ATTRIBUTION,
      // Build-gate runner is required by `RunDispatchOptions`'s
      // contract but should never be invoked when baseline is
      // skipped — Phase 5 short-circuits.
      buildGateRunner: async () => {
        throw new Error("build gate runner must not run with skip-baseline");
      },
      taskVerifier: PASS_VERIFIER,
    });

    expect(finalRun.baselineBuildLogPath).toBe("");
    expect(finalRun.status).toBe("done");
  });

  test("rejects a dispatch-config with a non-per-task commitStrategy", async () => {
    const bad = `${VALID_CONFIG}commitStrategy: grouped\n`;
    await writeFile(join(workDir, "dispatch-config.yaml"), bad, "utf8");
    const spec = {
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "locked-policy-run",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    };
    await expect(runDispatch(spec)).rejects.toThrow(/locked to "per-task"/);
  });

  test("resume hook is consulted when run-state.yaml already exists", async () => {
    // First, drive a normal run to completion so run-state.yaml exists.
    const spec = {
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "resume-run",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    };
    await runDispatch(spec, {
      plannerOverride: async () => buildSingleTaskPlan(),
      directorFactory: () =>
        scriptedDirector(implementerScriptFor("alpha.txt", "alpha-body\n")),
      criticRunner: PASS_CRITIC,
      gateCriticRunner: PASS_GATE_CRITIC,
      fixAgentRunner: FAIL_FIX_AGENT,
      phase5FixAgentRunner: FAIL_PHASE5_FIX,
      attributionRunner: FAIL_ATTRIBUTION,
      buildGateRunner: buildPassThroughBuildRunner({ current: workDir }),
      taskVerifier: PASS_VERIFIER,
    });

    // Second invocation: resume hook intercepts because the state file is present.
    let resumeCalled = 0;
    const resumed = await runDispatch(spec, {
      resume: async (runDir) => {
        resumeCalled++;
        return loadRun(join(runDir, "run-state.yaml"));
      },
    });
    expect(resumeCalled).toBe(1);
    expect(resumed.status).toBe("done");
  });
});
