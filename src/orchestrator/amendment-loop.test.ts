import { describe, expect, test } from "bun:test";

import type {
  CritiqueVerdict,
  Finding,
  GateVerdict,
  Run,
  Task,
} from "../state/index.js";

import {
  AMENDMENT_ESCALATE_ROUND,
  AMENDMENT_NOTIFY_ROUND,
  runAmendmentLoop,
} from "./amendment-loop.js";
import type {
  CriticRunner,
  FixAgentRunner,
  GateCriticRunner,
  OperatorResolutionCallback,
  RebuildCallback,
} from "./gate.js";

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

function passVerdict(round: number): CritiqueVerdict {
  return { round, status: "pass", findings: [], newTests: [] };
}

function amendVerdict(round: number, findings: Finding[]): CritiqueVerdict {
  return { round, status: "amend", findings, newTests: [] };
}

function gateAmend(level: number, round: number, perTask: Record<string, Finding[]>): GateVerdict {
  const entry: Record<string, { status: "amend" | "pass"; findings: Finding[] }> = {};
  for (const [taskId, findings] of Object.entries(perTask)) {
    entry[taskId] = {
      status: findings.length > 0 ? "amend" : "pass",
      findings,
    };
  }
  return { level, round, status: "amend", perTask: entry };
}

function gatePass(level: number, round: number, taskIds: string[]): GateVerdict {
  const perTask: Record<string, { status: "pass"; findings: Finding[] }> = {};
  for (const id of taskIds) perTask[id] = { status: "pass", findings: [] };
  return { level, round, status: "pass", perTask };
}

interface RecordedFixCall {
  readonly taskId: string;
  readonly findings: readonly Finding[];
  readonly round: number;
}

function makeRunners(opts: {
  /** Per-round gate verdict to return; index 0 corresponds to round 2 (first re-critique). */
  readonly gateVerdictsByRound: readonly GateVerdict[];
  /** Per-round per-task verdicts; same indexing as gateVerdictsByRound. */
  readonly perTaskVerdictsByRound: readonly ReadonlyMap<string, CritiqueVerdict>[];
  readonly rebuildLevel?: RebuildCallback;
  readonly operatorResolution?: OperatorResolutionCallback;
}) {
  let cursor = 0;
  const fixCalls: RecordedFixCall[] = [];
  const rebuildCalls: { fromLevel: number }[] = [];
  const operatorCalls: string[] = [];

  const criticRunner: CriticRunner = ({ task, round }) => {
    const perTask = opts.perTaskVerdictsByRound[cursor];
    if (perTask === undefined) {
      throw new Error(`test: criticRunner called past scripted rounds (cursor=${String(cursor)})`);
    }
    const v = perTask.get(task.id);
    if (v === undefined) {
      throw new Error(`test: no scripted critic verdict for ${task.id} at round ${String(round)}`);
    }
    return Promise.resolve(v);
  };

  const gateCriticRunner: GateCriticRunner = ({ round }) => {
    const v = opts.gateVerdictsByRound[cursor];
    if (v === undefined) {
      throw new Error(`test: gateCriticRunner called past scripted rounds (cursor=${String(cursor)})`);
    }
    cursor++;
    return Promise.resolve({ ...v, round });
  };

  const fixAgentRunner: FixAgentRunner = ({ task, findings }) => {
    fixCalls.push({
      taskId: task.id,
      findings,
      round: task.amendmentRoundsTotal,
    });
    return Promise.resolve();
  };

  const rebuildLevel: RebuildCallback = opts.rebuildLevel ?? ((run, fromLevel) => {
    rebuildCalls.push({ fromLevel });
    return Promise.resolve(run);
  });

  const awaitOperatorResolution: OperatorResolutionCallback =
    opts.operatorResolution ?? ((reason) => {
      operatorCalls.push(reason);
      return Promise.resolve("continue");
    });

  return {
    criticRunner,
    gateCriticRunner,
    fixAgentRunner,
    rebuildLevel,
    awaitOperatorResolution,
    fixCalls,
    rebuildCalls,
    operatorCalls,
  };
}

describe("runAmendmentLoop", () => {
  test("single amend round then pass marks committed tasks completed", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);
    const initial = gateAmend(1, 1, { t1: [blockingFinding("f1")] });
    const initialPerTask = new Map([["t1", amendVerdict(1, [blockingFinding("f1")])]]);

    const runners = makeRunners({
      gateVerdictsByRound: [gatePass(1, 2, ["t1"])],
      perTaskVerdictsByRound: [new Map([["t1", passVerdict(2)]])],
    });

    const result = await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: initialPerTask,
      ...runners,
    });

    expect(result.outcome).toBe("pass");
    expect(runners.fixCalls).toHaveLength(1);
    expect(runners.fixCalls[0]?.taskId).toBe("t1");
    expect(runners.rebuildCalls).toEqual([{ fromLevel: 1 }]);
    const t1 = result.run.tasks.find((t) => t.id === "t1");
    expect(t1?.status).toBe("completed");
    expect(t1?.amendmentRoundsTotal).toBe(1);
  });

  test("newTests from initial per-task verdict are merged into filesModified before fix", async () => {
    const tasks = [
      makeTask({
        id: "t1",
        output: {
          summary: "",
          filesModified: ["src/a.ts"],
          deviations: [],
          notes: "",
        },
      }),
    ];
    const run = makeRun(tasks);
    const initial = gateAmend(1, 1, { t1: [blockingFinding("f1")] });
    const initialPerTask = new Map<string, CritiqueVerdict>([
      [
        "t1",
        {
          round: 1,
          status: "amend",
          findings: [blockingFinding("f1")],
          newTests: ["tests/a.test.ts"],
        },
      ],
    ]);

    const runners = makeRunners({
      gateVerdictsByRound: [gatePass(1, 2, ["t1"])],
      perTaskVerdictsByRound: [new Map([["t1", passVerdict(2)]])],
    });

    const result = await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: initialPerTask,
      ...runners,
    });

    const t1 = result.run.tasks.find((t) => t.id === "t1");
    expect(t1?.output?.filesModified).toEqual(["src/a.ts", "tests/a.test.ts"]);
  });

  test("notifies at amendment round 3 without escalating", async () => {
    const tasks = [
      makeTask({ id: "t1", amendmentRoundsTotal: 2 }),
    ];
    const run = makeRun(tasks);
    const initial = gateAmend(1, 1, { t1: [blockingFinding("f1")] });
    const initialPerTask = new Map([["t1", amendVerdict(1, [blockingFinding("f1")])]]);

    const notifyMessages: string[] = [];
    const runners = makeRunners({
      gateVerdictsByRound: [gatePass(1, 2, ["t1"])],
      perTaskVerdictsByRound: [new Map([["t1", passVerdict(2)]])],
    });

    await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: initialPerTask,
      ...runners,
      notify: (m) => notifyMessages.push(m),
    });

    expect(AMENDMENT_NOTIFY_ROUND).toBe(3);
    expect(notifyMessages.some((m) => m.includes("round 3"))).toBe(true);
    expect(runners.operatorCalls).toHaveLength(0);
  });

  test("blocks on operator at amendment round 4 and respects continue", async () => {
    const tasks = [makeTask({ id: "t1", amendmentRoundsTotal: 3 })];
    const run = makeRun(tasks);
    const initial = gateAmend(1, 1, { t1: [blockingFinding("f1")] });
    const initialPerTask = new Map([["t1", amendVerdict(1, [blockingFinding("f1")])]]);

    const runners = makeRunners({
      gateVerdictsByRound: [gatePass(1, 2, ["t1"])],
      perTaskVerdictsByRound: [new Map([["t1", passVerdict(2)]])],
    });

    const result = await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: initialPerTask,
      ...runners,
    });

    expect(AMENDMENT_ESCALATE_ROUND).toBe(4);
    expect(runners.operatorCalls).toHaveLength(1);
    expect(runners.operatorCalls[0]).toContain("t1");
    expect(result.outcome).toBe("pass");
  });

  test("operator abort terminates the loop with outcome=abort", async () => {
    const tasks = [makeTask({ id: "t1", amendmentRoundsTotal: 3 })];
    const run = makeRun(tasks);
    const initial = gateAmend(1, 1, { t1: [blockingFinding("f1")] });
    const initialPerTask = new Map([["t1", amendVerdict(1, [blockingFinding("f1")])]]);

    const runners = makeRunners({
      gateVerdictsByRound: [],
      perTaskVerdictsByRound: [],
      operatorResolution: () => Promise.resolve("abort"),
    });

    const result = await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: initialPerTask,
      ...runners,
    });

    expect(result.outcome).toBe("abort");
    expect(runners.fixCalls).toHaveLength(0);
    expect(runners.rebuildCalls).toHaveLength(0);
  });

  test("fail gate verdict terminates immediately with outcome=fail", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);
    const initial: GateVerdict = {
      level: 1,
      round: 1,
      status: "fail",
      perTask: { t1: { status: "fail", findings: [blockingFinding("f1")] } },
    };

    const runners = makeRunners({
      gateVerdictsByRound: [],
      perTaskVerdictsByRound: [],
    });

    const result = await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: new Map(),
      ...runners,
    });

    expect(result.outcome).toBe("fail");
    expect(runners.fixCalls).toHaveLength(0);
  });

  test("multi-round: amend then amend then pass — counter increments per round", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);
    const initial = gateAmend(1, 1, { t1: [blockingFinding("f1")] });
    const initialPerTask = new Map([["t1", amendVerdict(1, [blockingFinding("f1")])]]);

    const runners = makeRunners({
      gateVerdictsByRound: [
        gateAmend(1, 2, { t1: [blockingFinding("f2")] }),
        gatePass(1, 3, ["t1"]),
      ],
      perTaskVerdictsByRound: [
        new Map([["t1", amendVerdict(2, [blockingFinding("f2")])]]),
        new Map([["t1", passVerdict(3)]]),
      ],
    });

    const result = await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: initialPerTask,
      ...runners,
    });

    const t1 = result.run.tasks.find((t) => t.id === "t1");
    expect(t1?.amendmentRoundsTotal).toBe(2);
    expect(runners.fixCalls).toHaveLength(2);
    expect(runners.rebuildCalls).toEqual([{ fromLevel: 1 }, { fromLevel: 1 }]);
    expect(result.outcome).toBe("pass");
  });

  test("only blocking tasks are fix-targeted; pass tasks left alone", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" })];
    const run = makeRun(tasks);
    const initial = gateAmend(1, 1, {
      t1: [blockingFinding("f1")],
      t2: [],
    });
    const initialPerTask = new Map<string, CritiqueVerdict>([
      ["t1", amendVerdict(1, [blockingFinding("f1")])],
      ["t2", passVerdict(1)],
    ]);

    const runners = makeRunners({
      gateVerdictsByRound: [gatePass(1, 2, ["t1", "t2"])],
      perTaskVerdictsByRound: [
        new Map<string, CritiqueVerdict>([
          ["t1", passVerdict(2)],
          ["t2", passVerdict(2)],
        ]),
      ],
    });

    await runAmendmentLoop({
      run,
      level: 1,
      initialGateVerdict: initial,
      initialPerTaskVerdicts: initialPerTask,
      ...runners,
    });

    expect(runners.fixCalls.map((c) => c.taskId)).toEqual(["t1"]);
  });
});
