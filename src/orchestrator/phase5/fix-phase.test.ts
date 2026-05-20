import { describe, expect, test } from "bun:test";

import type { BuildFailure, Run, Task } from "../../state/index.js";

import {
  PHASE5_ESCALATE_ROUND,
  PHASE5_NOTIFY_ROUND,
  runFixPhase,
  type Phase5FixAgentRunner,
  type TaskVerifier,
} from "./fix-phase.js";
import type { OperatorResolutionCallback } from "../gate.js";

function makeTask(over: Partial<Task> & { id: string }): Task {
  const base: Task = {
    id: over.id,
    level: 1,
    sequence: "a",
    dependsOn: [],
    objective: "",
    planMarkdown: "",
    agentType: "general",
    class: "feature",
    critiqueEnabled: true,
    verifyCommands: [],
    status: "committed",
    fixingSource: null,
    worktreePath: null,
    output: {
      summary: "",
      filesModified: [],
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
    name: "test-run",
    specPath: "/tmp/spec.md",
    targetRepoPath: "/tmp/target",
    integrationBranch: "main",
    baselineBuildLogPath: "/tmp/baseline.log",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "fixing-verification",
    tasks,
    levelBoundaries: { 0: "boundary-0" },
    gateVerdicts: [],
    verificationRounds: [],
    createdAt: new Date(0).toISOString(),
  };
}

function makeFailure(id: string): BuildFailure {
  return {
    id,
    file: "src/x.ts",
    line: 1,
    message: `failure ${id}`,
    rawText: `raw ${id}`,
  };
}

const PANIC_OPERATOR: OperatorResolutionCallback = () => {
  throw new Error("test: operator escalation should not be invoked");
};

const ALWAYS_OK_VERIFIER: TaskVerifier = () =>
  Promise.resolve({ ok: true, output: "ok" });

const ALWAYS_FAIL_VERIFIER: TaskVerifier = () =>
  Promise.resolve({ ok: false, output: "still broken" });

describe("runFixPhase", () => {
  test("clean path: one task, one failure, fix agent runs once, verifier passes", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);
    const failuresById = new Map([["f1", makeFailure("f1")]]);

    const fixCalls: string[] = [];
    const fixAgentRunner: Phase5FixAgentRunner = (input) => {
      fixCalls.push(input.task.id);
      expect(input.failures.map((f) => f.id)).toEqual(["f1"]);
      expect(input.findings).toHaveLength(1);
      expect(input.findings[0]?.severity).toBe("blocking");
      return Promise.resolve({ filesModified: ["src/x.ts"] });
    };

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map([["t1", "diff-t1"]]),
      fixAgentRunner,
      taskVerifier: ALWAYS_OK_VERIFIER,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(result.outcome).toBe("clean");
    expect(result.failedTaskIds).toHaveLength(0);
    expect(fixCalls).toEqual(["t1"]);
    const updated = result.run.tasks.find((t) => t.id === "t1");
    expect(updated?.status).toBe("committed");
    expect(updated?.fixingSource).toBeNull();
    expect(updated?.verificationFixRoundsTotal).toBe(1);
    expect(updated?.output?.filesModified).toEqual(["src/x.ts"]);
  });

  test("multiple tasks fix in lex order", async () => {
    const tasks = [
      makeTask({ id: "t-z" }),
      makeTask({ id: "t-a" }),
      makeTask({ id: "t-m" }),
    ];
    const run = makeRun(tasks);
    const failuresById = new Map([
      ["f1", makeFailure("f1")],
      ["f2", makeFailure("f2")],
      ["f3", makeFailure("f3")],
    ]);

    const order: string[] = [];
    const fixAgentRunner: Phase5FixAgentRunner = (input) => {
      order.push(input.task.id);
      return Promise.resolve({ filesModified: [] });
    };

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t-z"], f2: ["t-a"], f3: ["t-m"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier: ALWAYS_OK_VERIFIER,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(result.outcome).toBe("clean");
    expect(order).toEqual(["t-a", "t-m", "t-z"]);
  });

  test("attributes multiple failures to one task in a single fix-agent call", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);
    const failuresById = new Map([
      ["fA", makeFailure("fA")],
      ["fB", makeFailure("fB")],
    ]);

    let observedFailures: readonly BuildFailure[] = [];
    const fixAgentRunner: Phase5FixAgentRunner = (input) => {
      observedFailures = input.failures;
      return Promise.resolve({ filesModified: [] });
    };

    await runFixPhase({
      run,
      attribution: { fA: ["t1"], fB: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier: ALWAYS_OK_VERIFIER,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(observedFailures.map((f) => f.id).sort()).toEqual(["fA", "fB"]);
  });

  test("merges filesModified without duplicating existing entries", async () => {
    const tasks = [
      makeTask({
        id: "t1",
        output: {
          summary: "",
          filesModified: ["src/a.ts", "src/b.ts"],
          deviations: [],
          notes: "",
        },
      }),
    ];
    const run = makeRun(tasks);
    const failuresById = new Map([["f1", makeFailure("f1")]]);

    const fixAgentRunner: Phase5FixAgentRunner = () =>
      Promise.resolve({ filesModified: ["src/b.ts", "src/c.ts"] });

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier: ALWAYS_OK_VERIFIER,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    const updated = result.run.tasks.find((t) => t.id === "t1");
    expect(updated?.output?.filesModified).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  test("task-failed outcome when verifier never passes within the retry cap", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);
    const failuresById = new Map([["f1", makeFailure("f1")]]);

    let attempts = 0;
    const fixAgentRunner: Phase5FixAgentRunner = () => {
      attempts++;
      return Promise.resolve({ filesModified: [] });
    };

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier: ALWAYS_FAIL_VERIFIER,
      awaitOperatorResolution: PANIC_OPERATOR,
      maxRetriesPerTask: 2,
    });

    expect(result.outcome).toBe("task-failed");
    expect(result.failedTaskIds).toEqual(["t1"]);
    expect(attempts).toBe(2);
    const updated = result.run.tasks.find((t) => t.id === "t1");
    expect(updated?.status).toBe("failed");
  });

  test("recovers after a failed first attempt", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);
    const failuresById = new Map([["f1", makeFailure("f1")]]);

    let attempts = 0;
    const fixAgentRunner: Phase5FixAgentRunner = () => {
      attempts++;
      return Promise.resolve({ filesModified: [] });
    };
    let verifyCalls = 0;
    const taskVerifier: TaskVerifier = () => {
      verifyCalls++;
      return Promise.resolve(
        verifyCalls === 1
          ? { ok: false, output: "first fail" }
          : { ok: true, output: "second ok" },
      );
    };

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier,
      awaitOperatorResolution: PANIC_OPERATOR,
      maxRetriesPerTask: 3,
    });

    expect(result.outcome).toBe("clean");
    expect(attempts).toBe(2);
    expect(verifyCalls).toBe(2);
  });

  test("notify fires at round 3 without triggering the operator", async () => {
    const tasks = [
      makeTask({ id: "t1", verificationFixRoundsTotal: PHASE5_NOTIFY_ROUND - 1 }),
    ];
    const run = makeRun(tasks);
    const failuresById = new Map([["f1", makeFailure("f1")]]);

    const notifyMessages: string[] = [];
    const fixAgentRunner: Phase5FixAgentRunner = () =>
      Promise.resolve({ filesModified: [] });

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier: ALWAYS_OK_VERIFIER,
      awaitOperatorResolution: PANIC_OPERATOR,
      notify: (m) => notifyMessages.push(m),
    });

    expect(result.outcome).toBe("clean");
    expect(notifyMessages).toHaveLength(1);
    expect(notifyMessages[0]).toContain("round 3");
    const updated = result.run.tasks.find((t) => t.id === "t1");
    expect(updated?.verificationFixRoundsTotal).toBe(PHASE5_NOTIFY_ROUND);
  });

  test("operator escalation at round 4 -> continue keeps going", async () => {
    const tasks = [
      makeTask({
        id: "t1",
        verificationFixRoundsTotal: PHASE5_ESCALATE_ROUND - 1,
      }),
    ];
    const run = makeRun(tasks);
    const failuresById = new Map([["f1", makeFailure("f1")]]);

    let escalations = 0;
    const operator: OperatorResolutionCallback = () => {
      escalations++;
      return Promise.resolve("continue");
    };

    const fixAgentRunner: Phase5FixAgentRunner = () =>
      Promise.resolve({ filesModified: [] });

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier: ALWAYS_OK_VERIFIER,
      awaitOperatorResolution: operator,
    });

    expect(result.outcome).toBe("clean");
    expect(escalations).toBe(1);
  });

  test("operator escalation at round 4 -> abort returns operator-abort", async () => {
    const tasks = [
      makeTask({
        id: "t1",
        verificationFixRoundsTotal: PHASE5_ESCALATE_ROUND - 1,
      }),
    ];
    const run = makeRun(tasks);
    const failuresById = new Map([["f1", makeFailure("f1")]]);

    const operator: OperatorResolutionCallback = () =>
      Promise.resolve("abort");

    let fixCalls = 0;
    const fixAgentRunner: Phase5FixAgentRunner = () => {
      fixCalls++;
      return Promise.resolve({ filesModified: [] });
    };

    const result = await runFixPhase({
      run,
      attribution: { f1: ["t1"] },
      failuresById,
      committedDiffsByTaskId: new Map(),
      fixAgentRunner,
      taskVerifier: ALWAYS_OK_VERIFIER,
      awaitOperatorResolution: operator,
    });

    expect(result.outcome).toBe("operator-abort");
    expect(fixCalls).toBe(0);
  });
});
