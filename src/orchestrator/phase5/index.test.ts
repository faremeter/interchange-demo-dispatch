import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AttributionAgentRunner,
  BuildGateRunner,
  GateCallback,
  VerifyAgainstBaselineOptions,
} from "./index.js";
import { verifyAgainstBaseline } from "./index.js";
import type { Phase5FixAgentRunner, TaskVerifier } from "./fix-phase.js";
import type {
  OperatorResolutionCallback,
  RebuildCallback,
} from "../gate.js";
import { loadRun } from "../../state/index.js";
import type { Run, Task } from "../../state/index.js";

function makeTask(over: Partial<Task> & { id: string }): Task {
  const base: Task = {
    id: over.id,
    level: 1,
    sequence: "a",
    dependsOn: [],
    objective: "do the thing",
    planMarkdown: "plan",
    agentType: "general",
    class: "feature",
    critiqueEnabled: true,
    verifyCommands: [],
    status: "completed",
    fixingSource: null,
    worktreePath: null,
    output: {
      summary: "",
      filesModified: ["src/x.ts"],
      deviations: [],
      notes: "",
    },
    commitSHA: `sha-${over.id}`,
    critiqueVerdicts: [],
    amendmentRoundsTotal: 0,
    verificationFixRoundsTotal: 0,
  };
  return { ...base, ...over };
}

function makeRun(tasks: Task[]): Run {
  return {
    name: "phase5-test",
    specPath: "/tmp/spec.md",
    targetRepoPath: "/tmp/target",
    integrationBranch: "main",
    baselineBuildLogPath: "/tmp/baseline.log",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "verifying",
    tasks,
    levelBoundaries: { 0: "boundary-0", 1: "boundary-1" },
    gateVerdicts: [],
    verificationRounds: [],
    createdAt: new Date(0).toISOString(),
  };
}

const PANIC_REBUILD: RebuildCallback = () => {
  throw new Error("rebuildLevel should not be invoked in this scenario");
};
const PANIC_GATE: GateCallback = () => {
  throw new Error("gate should not be invoked in this scenario");
};
const PANIC_OPERATOR: OperatorResolutionCallback = () => {
  throw new Error("operator should not be invoked in this scenario");
};
const PANIC_ATTRIBUTION: AttributionAgentRunner = () => {
  throw new Error("attribution should not be invoked in this scenario");
};
const PANIC_FIX_AGENT: Phase5FixAgentRunner = () => {
  throw new Error("fixAgent should not be invoked in this scenario");
};
const PANIC_TASK_VERIFIER: TaskVerifier = () => {
  throw new Error("taskVerifier should not be invoked in this scenario");
};

interface Harness {
  readonly tmpDir: string;
  readonly runDir: string;
  readonly worktreePath: string;
  readonly baselineLogPath: string;
  readonly runStatePath: string;
}

async function setupHarness(): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), "phase5-index-"));
  const worktreePath = join(tmpDir, "worktree");
  const runDir = join(tmpDir, "dispatch");
  const baselineLogPath = join(tmpDir, "baseline.log");
  const runStatePath = join(runDir, "run-state.yaml");
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDir, { recursive: true });
  return { tmpDir, runDir, worktreePath, baselineLogPath, runStatePath };
}

async function teardown(harness: Harness): Promise<void> {
  await rm(harness.tmpDir, { recursive: true, force: true });
}

function baseOptions(
  harness: Harness,
  over: Partial<VerifyAgainstBaselineOptions> = {},
): VerifyAgainstBaselineOptions {
  return {
    worktreePath: harness.worktreePath,
    runDir: harness.runDir,
    runStatePath: harness.runStatePath,
    baselineLogPath: harness.baselineLogPath,
    buildGateRunner: over.buildGateRunner ?? (() =>
      Promise.resolve({ output: "", exitCode: 0 })),
    attributionRunner: over.attributionRunner ?? PANIC_ATTRIBUTION,
    fixAgentRunner: over.fixAgentRunner ?? PANIC_FIX_AGENT,
    taskVerifier: over.taskVerifier ?? PANIC_TASK_VERIFIER,
    rebuildLevel: over.rebuildLevel ?? PANIC_REBUILD,
    gate: over.gate ?? PANIC_GATE,
    awaitOperatorResolution: over.awaitOperatorResolution ?? PANIC_OPERATOR,
    committedDiffsByTaskId:
      over.committedDiffsByTaskId ?? new Map<string, string>(),
    ...(over.notify !== undefined ? { notify: over.notify } : {}),
    ...(over.maxLoops !== undefined ? { maxLoops: over.maxLoops } : {}),
    ...(over.normalizeExtraPathPrefixes !== undefined
      ? { normalizeExtraPathPrefixes: over.normalizeExtraPathPrefixes }
      : {}),
  };
}

describe("verifyAgainstBaseline", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness !== undefined) await teardown(harness);
    harness = await setupHarness();
  });

  test("empty-modifications skip: all tasks have empty filesModified", async () => {
    const tasks = [
      makeTask({
        id: "t1",
        output: { summary: "", filesModified: [], deviations: [], notes: "" },
      }),
    ];
    const run = makeRun(tasks);
    await writeFile(harness.baselineLogPath, "ok\n", "utf8");
    const result = await verifyAgainstBaseline(
      run,
      baseOptions(harness, {
        buildGateRunner: () => {
          throw new Error("buildGateRunner should not be called");
        },
      }),
    );
    expect(result.status).toBe("consolidating");
    expect(result.verificationRounds).toHaveLength(0);
    const persisted = await loadRun(harness.runStatePath);
    expect(persisted.status).toBe("consolidating");
  });

  test("clean pass: baseline and final outputs match after normalization", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);

    const baseline = "\x1b[31mFAIL\x1b[0m at 2024-05-20T10:11:12Z (12ms)\n";
    const final = "FAIL at 2024-05-21T08:09:10Z (40ms)\n";
    await writeFile(harness.baselineLogPath, baseline, "utf8");

    const buildGateRunner: BuildGateRunner = () =>
      Promise.resolve({ output: final, exitCode: 0 });

    const result = await verifyAgainstBaseline(
      run,
      baseOptions(harness, { buildGateRunner }),
    );

    expect(result.status).toBe("consolidating");
    expect(result.verificationRounds).toHaveLength(1);
    expect(result.verificationRounds[0]?.outcome).toBe("pass");
    expect(result.verificationRounds[0]?.newFailures).toHaveLength(0);
  });

  test("new failure: attribution + fix + rebuild + re-gate + re-verify", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2", level: 2 })];
    const run = makeRun(tasks);

    const baseline = "everything ok\n";
    await writeFile(harness.baselineLogPath, baseline, "utf8");

    let buildCalls = 0;
    const buildGateRunner: BuildGateRunner = () => {
      buildCalls++;
      if (buildCalls === 1) {
        return Promise.resolve({
          output:
            "FAIL src/x.ts:42 expected something, got something else\n",
          exitCode: 1,
        });
      }
      return Promise.resolve({ output: "everything ok\n", exitCode: 0 });
    };

    const attributionRunner: AttributionAgentRunner = (input) => {
      expect(input.newFailures).toHaveLength(1);
      const failure = input.newFailures[0];
      if (failure === undefined) throw new Error("missing failure");
      return Promise.resolve({ attribution: { [failure.id]: ["t1"] } });
    };

    let fixCalls = 0;
    const fixAgentRunner: Phase5FixAgentRunner = (input) => {
      fixCalls++;
      expect(input.task.id).toBe("t1");
      return Promise.resolve({ filesModified: ["src/x.ts"] });
    };

    const taskVerifier: TaskVerifier = () =>
      Promise.resolve({ ok: true, output: "ok" });

    let rebuildCalls = 0;
    const rebuildLevel: RebuildCallback = (workingRun, fromLevel) => {
      rebuildCalls++;
      expect(fromLevel).toBe(1);
      return Promise.resolve(workingRun);
    };

    let gateCalls = 0;
    const gate: GateCallback = (input) => {
      gateCalls++;
      return Promise.resolve({ run: input.run, outcome: "pass" });
    };

    const result = await verifyAgainstBaseline(
      run,
      baseOptions(harness, {
        buildGateRunner,
        attributionRunner,
        fixAgentRunner,
        taskVerifier,
        rebuildLevel,
        gate,
      }),
    );

    expect(result.status).toBe("consolidating");
    expect(buildCalls).toBe(2);
    expect(fixCalls).toBe(1);
    expect(rebuildCalls).toBe(1);
    expect(gateCalls).toBe(2);
    expect(result.verificationRounds).toHaveLength(2);
    expect(result.verificationRounds[0]?.outcome).toBe("retry");
    expect(result.verificationRounds[0]?.rebuildFromLevel).toBe(1);
    expect(result.verificationRounds[1]?.outcome).toBe("pass");

    const t1 = result.tasks.find((t) => t.id === "t1");
    expect(t1?.verificationFixRoundsTotal).toBe(1);
  });

  test("operator-abort during fix phase produces failed status", async () => {
    const tasks = [
      makeTask({
        id: "t1",
        verificationFixRoundsTotal: 3, // next round = 4 -> escalate
      }),
    ];
    const run = makeRun(tasks);

    await writeFile(harness.baselineLogPath, "ok\n", "utf8");
    const buildGateRunner: BuildGateRunner = () =>
      Promise.resolve({
        output: "FAIL something broke\n",
        exitCode: 1,
      });

    const attributionRunner: AttributionAgentRunner = (input) => {
      const f = input.newFailures[0];
      if (f === undefined) throw new Error("expected a failure");
      return Promise.resolve({ attribution: { [f.id]: ["t1"] } });
    };

    const operatorChoices: string[] = [];
    const awaitOperatorResolution: OperatorResolutionCallback = (reason) => {
      operatorChoices.push(reason);
      return Promise.resolve("abort");
    };

    const result = await verifyAgainstBaseline(
      run,
      baseOptions(harness, {
        buildGateRunner,
        attributionRunner,
        awaitOperatorResolution,
      }),
    );

    expect(result.status).toBe("failed");
    expect(operatorChoices).toHaveLength(1);
    expect(operatorChoices[0]).toContain("verification-fix round 4");
  });

  test("rebuilt-level gate returns fail -> run marked failed", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2", level: 2 })];
    const run = makeRun(tasks);

    await writeFile(harness.baselineLogPath, "ok\n", "utf8");
    const buildGateRunner: BuildGateRunner = () =>
      Promise.resolve({ output: "FAIL broken\n", exitCode: 1 });

    const attributionRunner: AttributionAgentRunner = (input) => {
      const f = input.newFailures[0];
      if (f === undefined) throw new Error("expected a failure");
      return Promise.resolve({ attribution: { [f.id]: ["t1"] } });
    };

    const fixAgentRunner: Phase5FixAgentRunner = () =>
      Promise.resolve({ filesModified: [] });
    const taskVerifier: TaskVerifier = () =>
      Promise.resolve({ ok: true, output: "ok" });
    const rebuildLevel: RebuildCallback = (r) => Promise.resolve(r);

    const gate: GateCallback = (input) =>
      Promise.resolve({ run: input.run, outcome: "fail" });

    const result = await verifyAgainstBaseline(
      run,
      baseOptions(harness, {
        buildGateRunner,
        attributionRunner,
        fixAgentRunner,
        taskVerifier,
        rebuildLevel,
        gate,
      }),
    );

    expect(result.status).toBe("failed");
  });

  test("normalized outputs differ but no parseable failures -> escalate; abort", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);

    await writeFile(harness.baselineLogPath, "exit zero clean run\n", "utf8");
    // The final output is different from baseline yet contains no
    // failure markers (no "error"/"FAIL"/etc.). The engine should
    // escalate rather than entering attribution.
    const buildGateRunner: BuildGateRunner = () =>
      Promise.resolve({
        output: "warning: something subtle changed but no parseable failures\n",
        exitCode: 0,
      });

    let escalations = 0;
    const awaitOperatorResolution: OperatorResolutionCallback = () => {
      escalations++;
      return Promise.resolve("abort");
    };

    const result = await verifyAgainstBaseline(
      run,
      baseOptions(harness, {
        buildGateRunner,
        awaitOperatorResolution,
      }),
    );

    expect(escalations).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.verificationRounds).toHaveLength(1);
    expect(result.verificationRounds[0]?.outcome).toBe("escalated");
  });

  test("persists run state on every transition", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);

    await writeFile(harness.baselineLogPath, "ok\n", "utf8");
    const buildGateRunner: BuildGateRunner = () =>
      Promise.resolve({ output: "ok\n", exitCode: 0 });

    const result = await verifyAgainstBaseline(
      run,
      baseOptions(harness, { buildGateRunner }),
    );

    expect(result.status).toBe("consolidating");
    const persisted = await loadRun(harness.runStatePath);
    expect(persisted.status).toBe("consolidating");
    expect(persisted.verificationRounds).toHaveLength(1);

    // Final-build log on disk
    const round1 = result.verificationRounds[0];
    if (round1 === undefined) throw new Error("expected one verification round");
    const logContents = await readFile(round1.finalBuildLogPath, "utf8");
    expect(logContents).toBe("ok\n");
  });
});
