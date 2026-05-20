// Tests for `runKarenLoopForTask`.
//
// The loop ties together Karen's policy, the greybeard agent factory, and the
// operator escape-hatch. Tests inject stubs for the greybeard spawner and the
// operator resolver so every branch (accept, markFailed direct, consult ->
// accept/reject/escalate, escalate direct -> continue/abort) is exercised
// without standing up a real agent or filesystem-polling.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Deviation, Task } from "../state/types.js";
import {
  runKarenLoopForTask,
  type GreybeardAgentHandle,
  type GreybeardSpawner,
  type OperatorResolver,
} from "./karen-loop.js";

const BASE_TASK: Task = {
  id: "task-1",
  level: 1,
  sequence: "a",
  dependsOn: [],
  objective: "test",
  planMarkdown: "# plan",
  agentType: "general",
  class: "feature",
  critiqueEnabled: true,
  verifyCommands: [],
  status: "submitted",
  fixingSource: null,
  worktreePath: "/tmp/wt",
  output: null,
  commitSHA: null,
  critiqueVerdicts: [],
  amendmentRoundsTotal: 0,
  verificationFixRoundsTotal: 0,
};

function minorDeviation(id: string): Deviation {
  return {
    id,
    severity: "minor",
    category: "scope",
    description: "trivial",
    affectedFiles: [],
  };
}

function moderateDeviation(id: string): Deviation {
  return {
    id,
    severity: "moderate",
    category: "scope",
    description: "needs review",
    affectedFiles: [],
  };
}

function majorDeviation(id: string): Deviation {
  return {
    id,
    severity: "major",
    category: "scope",
    description: "operator decides",
    affectedFiles: [],
  };
}

function fakeAgent(): GreybeardAgentHandle & { readonly closed: boolean } {
  let closed = false;
  return {
    async send() {
      return { messages: [] };
    },
    async close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

function spawnerThatReturns(
  verdict: "accept" | "reject" | "escalate",
  rationale = "rationale",
): GreybeardSpawner {
  return async (opts) => ({
    agent: fakeAgent(),
    awaitVerdict: Promise.resolve({
      taskId: opts.taskId,
      deviationId: opts.deviation.id,
      verdict,
      rationale,
    }),
  });
}

function buildOptions(extra: {
  deviations: Deviation[];
  greybeardSpawner?: GreybeardSpawner;
  operatorResolver?: OperatorResolver;
  task?: Task;
  runDir?: string;
}) {
  return {
    task: extra.task ?? BASE_TASK,
    deviations: extra.deviations,
    runDir: extra.runDir ?? "/tmp/unused",
    planPath: "/tmp/plan.md",
    outputPath: "/tmp/output.yaml",
    worktreePath: "/tmp/wt",
    greybeardContextRoot: "/tmp/ctx",
    model: "claude-test",
    baseURL: "https://example.invalid",
    apiKey: "test-key",
    adapter: "anthropic",
    ...(extra.greybeardSpawner !== undefined
      ? { greybeardSpawner: extra.greybeardSpawner }
      : {}),
    ...(extra.operatorResolver !== undefined
      ? { operatorResolver: extra.operatorResolver }
      : {}),
  };
}

describe("runKarenLoopForTask", () => {
  test("accept-only: every deviation is minor; final state is accepted", async () => {
    let tmpRoot: string | undefined;
    try {
      tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [minorDeviation("d1"), minorDeviation("d2")],
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(result.finalState.kind).toBe("accepted");
      expect(result.decisions).toHaveLength(2);
      expect(result.decisions[0]?.initial).toBe("accept");
      expect(result.decisions[1]?.initial).toBe("accept");
    } finally {
      if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("greybeard accept verdict translates to Karen accept and loop continues", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
    try {
      const dev = moderateDeviation("d1");
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [dev],
          greybeardSpawner: spawnerThatReturns("accept", "ok"),
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(result.finalState.kind).toBe("accepted");
      const decision = result.decisions[0];
      expect(decision?.greybeard?.verdict).toBe("accept");
      expect(decision?.greybeard?.final).toBe("accept");
      expect(decision?.outcome).toBe("accepted");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("greybeard reject verdict translates to markFailed and short-circuits", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
    try {
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [moderateDeviation("d1"), moderateDeviation("d2")],
          greybeardSpawner: spawnerThatReturns("reject", "no good"),
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(result.finalState.kind).toBe("failed");
      // Only the first deviation should have been processed before the loop
      // short-circuits.
      expect(result.decisions).toHaveLength(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("greybeard escalate verdict triggers operator resolution; continue keeps loop alive", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
    try {
      const operatorResolver: OperatorResolver = async () => "continue";
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [moderateDeviation("d1"), minorDeviation("d2")],
          greybeardSpawner: spawnerThatReturns("escalate", "unsure"),
          operatorResolver,
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(result.finalState.kind).toBe("accepted");
      expect(result.decisions).toHaveLength(2);
      expect(result.decisions[0]?.operator).toBe("continue");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("greybeard escalate verdict + operator abort short-circuits as aborted", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
    try {
      const operatorResolver: OperatorResolver = async () => "abort";
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [moderateDeviation("d1"), minorDeviation("d2")],
          greybeardSpawner: spawnerThatReturns("escalate", "unsure"),
          operatorResolver,
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(result.finalState.kind).toBe("aborted");
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]?.operator).toBe("abort");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("major deviation escalates directly to operator without greybeard", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
    try {
      let spawned = false;
      const greybeardSpawner: GreybeardSpawner = async () => {
        spawned = true;
        throw new Error("should not be called");
      };
      const operatorResolver: OperatorResolver = async () => "continue";
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [majorDeviation("d1")],
          greybeardSpawner,
          operatorResolver,
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(spawned).toBe(false);
      expect(result.finalState.kind).toBe("accepted");
      expect(result.decisions[0]?.initial).toBe("escalateToOperator");
      expect(result.decisions[0]?.greybeard).toBeUndefined();
      expect(result.decisions[0]?.operator).toBe("continue");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("greybeard agent is closed even when verdict resolution races the reactor", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
    try {
      let closedCount = 0;
      const spawner: GreybeardSpawner = async (opts) => {
        return {
          agent: {
            async send() {
              return { messages: [] };
            },
            async close() {
              closedCount++;
            },
          } satisfies GreybeardAgentHandle,
          awaitVerdict: Promise.resolve({
            taskId: opts.taskId,
            deviationId: opts.deviation.id,
            verdict: "accept" as const,
            rationale: "ok",
          }),
        };
      };
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [moderateDeviation("d1")],
          greybeardSpawner: spawner,
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(closedCount).toBe(1);
      expect(result.finalState.kind).toBe("accepted");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("decisions log preserves order of evaluated deviations", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "karen-test-"));
    try {
      const result = await runKarenLoopForTask({
        ...buildOptions({
          deviations: [
            minorDeviation("d-a"),
            moderateDeviation("d-b"),
            minorDeviation("d-c"),
          ],
          greybeardSpawner: spawnerThatReturns("accept"),
        }),
        greybeardContextRoot: tmpRoot,
      });
      expect(result.decisions.map((d) => d.deviationId)).toEqual([
        "d-a",
        "d-b",
        "d-c",
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
