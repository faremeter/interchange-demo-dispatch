import { describe, expect, test } from "bun:test";

import type {
  AgentType,
  CritiqueVerdict,
  Finding,
  GateVerdict,
  Run,
  Task,
} from "../state/index.js";

import { gate } from "./gate.js";
import type {
  CriticRunner,
  FixAgentRunner,
  GateCriticRunner,
  OperatorResolutionCallback,
  RebuildCallback,
} from "./gate.js";

function makeTask(over: Partial<Task> & { id: string; agentType?: AgentType }): Task {
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
    baselineBuildLogPath: "/tmp/build.log",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "executing",
    tasks,
    levelBoundaries: { 0: "boundary-0" },
    gateVerdicts: [],
    verificationRounds: [],
    createdAt: new Date(0).toISOString(),
  };
}

function blockingFinding(id: string): Finding {
  return {
    id,
    severity: "blocking",
    description: "needs fix",
    filePath: null,
    lineRange: null,
  };
}

function passCritique(round: number): CritiqueVerdict {
  return { round, status: "pass", findings: [], newTests: [] };
}

const PANIC_REBUILD: RebuildCallback = () => {
  throw new Error("test: rebuildLevel should not be called in this scenario");
};
const PANIC_OPERATOR: OperatorResolutionCallback = () => {
  throw new Error("test: operator escalation should not be invoked");
};
const PANIC_FIX_AGENT: FixAgentRunner = () => {
  throw new Error("test: fixAgentRunner should not be invoked");
};

describe("gate", () => {
  test("pass path: critic + gate-critic both pass; tasks move to completed", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" })];
    const run = makeRun(tasks);

    const criticRunner: CriticRunner = ({ round }) =>
      Promise.resolve({
        round,
        status: "pass",
        findings: [],
        newTests: [],
      } satisfies CritiqueVerdict);

    const gateCriticRunner: GateCriticRunner = ({ level, round, perTaskVerdicts }) => {
      expect(perTaskVerdicts).toHaveLength(2);
      const perTask: Record<string, { status: "pass"; findings: Finding[] }> = {};
      for (const { taskId } of perTaskVerdicts) {
        perTask[taskId] = { status: "pass", findings: [] };
      }
      const verdict: GateVerdict = { level, round, status: "pass", perTask };
      return Promise.resolve(verdict);
    };

    const result = await gate(run, 1, {
      criticRunner,
      gateCriticRunner,
      fixAgentRunner: PANIC_FIX_AGENT,
      rebuildLevel: PANIC_REBUILD,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(result.outcome).toBe("pass");
    expect(result.gateVerdict.status).toBe("pass");
    expect(result.run.gateVerdicts).toHaveLength(1);
    for (const t of result.run.tasks) {
      expect(t.status).toBe("completed");
      expect(t.critiqueVerdicts).toHaveLength(1);
    }
  });

  test("fail path: gate critic returns fail; loop terminates with outcome=fail", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);

    const criticRunner: CriticRunner = ({ round }) =>
      Promise.resolve(passCritique(round));

    const gateCriticRunner: GateCriticRunner = ({ level, round }) =>
      Promise.resolve({
        level,
        round,
        status: "fail",
        perTask: { t1: { status: "fail", findings: [blockingFinding("oops")] } },
      });

    const result = await gate(run, 1, {
      criticRunner,
      gateCriticRunner,
      fixAgentRunner: PANIC_FIX_AGENT,
      rebuildLevel: PANIC_REBUILD,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(result.outcome).toBe("fail");
    expect(result.gateVerdict.status).toBe("fail");
    expect(result.run.gateVerdicts).toHaveLength(1);
  });

  test("amend path drives the amendment loop and resolves on the next pass", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);

    let gateCalls = 0;
    let criticCalls = 0;
    let fixCalls = 0;
    let rebuildCalls = 0;

    const criticRunner: CriticRunner = ({ round }) => {
      criticCalls++;
      if (criticCalls === 1) {
        return Promise.resolve({
          round,
          status: "amend",
          findings: [blockingFinding("first")],
          newTests: [],
        } satisfies CritiqueVerdict);
      }
      return Promise.resolve(passCritique(round));
    };

    const gateCriticRunner: GateCriticRunner = ({ level, round }) => {
      gateCalls++;
      if (gateCalls === 1) {
        return Promise.resolve({
          level,
          round,
          status: "amend",
          perTask: { t1: { status: "amend", findings: [blockingFinding("first")] } },
        });
      }
      return Promise.resolve({
        level,
        round,
        status: "pass",
        perTask: { t1: { status: "pass", findings: [] } },
      });
    };

    const fixAgentRunner: FixAgentRunner = () => {
      fixCalls++;
      return Promise.resolve();
    };

    const rebuildLevel: RebuildCallback = (r) => {
      rebuildCalls++;
      return Promise.resolve(r);
    };

    const result = await gate(run, 1, {
      criticRunner,
      gateCriticRunner,
      fixAgentRunner,
      rebuildLevel,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(result.outcome).toBe("pass");
    expect(gateCalls).toBe(2);
    expect(criticCalls).toBe(2);
    expect(fixCalls).toBe(1);
    expect(rebuildCalls).toBe(1);
    const t1 = result.run.tasks.find((t) => t.id === "t1");
    expect(t1?.amendmentRoundsTotal).toBe(1);
    expect(t1?.status).toBe("completed");
  });

  test("amend path: non-blocking sibling tasks reach completed alongside fixed ones", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" })];
    const run = makeRun(tasks);

    let gateCalls = 0;
    const criticRunner: CriticRunner = ({ task, round }) => {
      if (task.id === "t1" && round === 1) {
        return Promise.resolve({
          round,
          status: "amend",
          findings: [blockingFinding("first")],
          newTests: [],
        } satisfies CritiqueVerdict);
      }
      return Promise.resolve(passCritique(round));
    };

    const gateCriticRunner: GateCriticRunner = ({ level, round }) => {
      gateCalls++;
      if (gateCalls === 1) {
        return Promise.resolve({
          level,
          round,
          status: "amend",
          perTask: {
            t1: { status: "amend", findings: [blockingFinding("first")] },
            t2: { status: "pass", findings: [] },
          },
        });
      }
      return Promise.resolve({
        level,
        round,
        status: "pass",
        perTask: {
          t1: { status: "pass", findings: [] },
          t2: { status: "pass", findings: [] },
        },
      });
    };

    const result = await gate(run, 1, {
      criticRunner,
      gateCriticRunner,
      fixAgentRunner: () => Promise.resolve(),
      rebuildLevel: (r) => Promise.resolve(r),
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(result.outcome).toBe("pass");
    const t1 = result.run.tasks.find((t) => t.id === "t1");
    const t2 = result.run.tasks.find((t) => t.id === "t2");
    expect(t1?.status).toBe("completed");
    expect(t1?.amendmentRoundsTotal).toBe(1);
    expect(t2?.status).toBe("completed");
    expect(t2?.amendmentRoundsTotal).toBe(0);
  });

  test("explore agents bypass the critic but still pass through to completed", async () => {
    const tasks = [
      makeTask({ id: "t-gen", agentType: "general" }),
      makeTask({ id: "t-explore", agentType: "explore" }),
    ];
    const run = makeRun(tasks);

    const criticCalls: string[] = [];
    const criticRunner: CriticRunner = ({ task, round }) => {
      criticCalls.push(task.id);
      return Promise.resolve(passCritique(round));
    };

    const gateCriticRunner: GateCriticRunner = ({ level, round, perTaskVerdicts }) => {
      const perTask: Record<string, { status: "pass"; findings: Finding[] }> = {};
      for (const { taskId } of perTaskVerdicts) {
        perTask[taskId] = { status: "pass", findings: [] };
      }
      return Promise.resolve({ level, round, status: "pass", perTask });
    };

    const result = await gate(run, 1, {
      criticRunner,
      gateCriticRunner,
      fixAgentRunner: PANIC_FIX_AGENT,
      rebuildLevel: PANIC_REBUILD,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(criticCalls).toEqual(["t-gen"]);
    expect(result.outcome).toBe("pass");
    for (const t of result.run.tasks) {
      expect(t.status).toBe("completed");
    }
  });

  test("intern with critiqueEnabled=false skips the per-task critic", async () => {
    const tasks = [
      makeTask({ id: "t-intern", agentType: "intern", critiqueEnabled: false }),
      makeTask({ id: "t-gen", agentType: "general" }),
    ];
    const run = makeRun(tasks);

    const criticCalls: string[] = [];
    const criticRunner: CriticRunner = ({ task, round }) => {
      criticCalls.push(task.id);
      return Promise.resolve(passCritique(round));
    };

    const gateCriticRunner: GateCriticRunner = ({ level, round, perTaskVerdicts }) => {
      const perTask: Record<string, { status: "pass"; findings: Finding[] }> = {};
      for (const { taskId } of perTaskVerdicts) {
        perTask[taskId] = { status: "pass", findings: [] };
      }
      return Promise.resolve({ level, round, status: "pass", perTask });
    };

    await gate(run, 1, {
      criticRunner,
      gateCriticRunner,
      fixAgentRunner: PANIC_FIX_AGENT,
      rebuildLevel: PANIC_REBUILD,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    expect(criticCalls).toEqual(["t-gen"]);
  });

  test("rejects when not all tasks at the level are committed", async () => {
    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", status: "running" }),
    ];
    const run = makeRun(tasks);

    await expect(
      gate(run, 1, {
        criticRunner: () => {
          throw new Error("should not be invoked");
        },
        gateCriticRunner: () => {
          throw new Error("should not be invoked");
        },
        fixAgentRunner: PANIC_FIX_AGENT,
        rebuildLevel: PANIC_REBUILD,
        awaitOperatorResolution: PANIC_OPERATOR,
      }),
    ).rejects.toThrow(/must be "committed"/);
  });

  test("stamps the orchestrator-owned round on each critique verdict", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);

    const criticRunner: CriticRunner = ({ round }) =>
      Promise.resolve({
        round,
        status: "pass",
        findings: [],
        newTests: [],
      } satisfies CritiqueVerdict);

    const gateCriticRunner: GateCriticRunner = ({ level, round }) =>
      Promise.resolve({
        level,
        round,
        status: "pass",
        perTask: { t1: { status: "pass", findings: [] } },
      });

    const result = await gate(run, 1, {
      criticRunner,
      gateCriticRunner,
      fixAgentRunner: PANIC_FIX_AGENT,
      rebuildLevel: PANIC_REBUILD,
      awaitOperatorResolution: PANIC_OPERATOR,
    });

    const t1 = result.run.tasks.find((t) => t.id === "t1");
    expect(t1?.critiqueVerdicts).toHaveLength(1);
    expect(t1?.critiqueVerdicts[0]?.round).toBe(1);
    expect(result.gateVerdict.round).toBe(1);
  });
});
