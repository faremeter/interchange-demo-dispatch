// Bounded amendment loop.
//
// When the per-level gate critic returns `amend`, the orchestrator runs
// this loop: spawn a fix agent per task with blocking findings, await
// their submitted outputs, append any `newTests` declared by the per-task
// critics to the responsible task's `filesModified`, ask the rebuild
// callback (delegated from `5c-commit-level`) to redo the level's commits
// from this level's pre-level boundary, and re-run the critic + gate
// critic on the rebuilt state.
//
// Round counter (spec.md §611-§615): `Task.amendmentRoundsTotal` is the
// per-task counter accumulating critique-driven amendment rounds across
// normal execution. This module increments it once per re-entry per task
// per round. At round 3 the loop logs a notice; at round 4+ it asks the
// operator (via the injected `awaitOperatorResolution` callback) whether
// to continue or abort.
//
// PoC scope (matching `4a-critic-surfaces`): no mutation-testing /
// `validate-fix` semantics. Pass through gate verdicts and findings as
// the brief specifies them.

import type {
  CritiqueVerdict,
  Finding,
  GateVerdict,
  PerTaskGateVerdict,
  Run,
  Task,
} from "../state/index.js";

import type {
  CriticRunner,
  FixAgentRunner,
  GateCriticRunner,
  OperatorResolutionCallback,
  RebuildCallback,
} from "./gate.js";

/**
 * Round at which the loop logs a notice to the operator.
 * (spec.md §611-§615 — "notify at round 3".)
 */
export const AMENDMENT_NOTIFY_ROUND = 3;
/**
 * Round at which the loop blocks on operator resolution.
 * (spec.md §611-§615 — "ask operator at round 4+".)
 */
export const AMENDMENT_ESCALATE_ROUND = 4;

export interface RunAmendmentLoopOptions {
  readonly run: Run;
  readonly level: number;
  /** The most recent gate verdict that triggered this loop (status === "amend"). */
  readonly initialGateVerdict: GateVerdict;
  /** Initial per-task critic verdicts produced by `gate(...)` before this loop entered. */
  readonly initialPerTaskVerdicts: ReadonlyMap<string, CritiqueVerdict>;
  readonly criticRunner: CriticRunner;
  readonly gateCriticRunner: GateCriticRunner;
  readonly fixAgentRunner: FixAgentRunner;
  readonly rebuildLevel: RebuildCallback;
  readonly awaitOperatorResolution: OperatorResolutionCallback;
  /**
   * Optional logger sink for the round-3 notice. Defaults to a noop in
   * tests; the orchestrator wires its real logger in production.
   */
  readonly notify?: (message: string) => void;
}

export interface AmendmentLoopResult {
  readonly run: Run;
  /** The final gate verdict that terminated the loop (pass | fail | abort). */
  readonly finalGateVerdict: GateVerdict;
  /**
   * "pass" if the level is now clean; "abort" if the operator chose to
   * abort during an escalation; "fail" if the gate critic returned `fail`.
   */
  readonly outcome: "pass" | "abort" | "fail";
}

export async function runAmendmentLoop(
  options: RunAmendmentLoopOptions,
): Promise<AmendmentLoopResult> {
  let run = options.run;
  let gateVerdict = options.initialGateVerdict;
  let perTaskVerdicts = options.initialPerTaskVerdicts;

  while (true) {
    if (gateVerdict.status === "pass") {
      run = markCommittedTasksCompleted(run, options.level);
      return { run, finalGateVerdict: gateVerdict, outcome: "pass" };
    }
    if (gateVerdict.status === "fail") {
      return { run, finalGateVerdict: gateVerdict, outcome: "fail" };
    }

    const blockingTaskIds = collectBlockingTaskIds(gateVerdict);
    if (blockingTaskIds.length === 0) {
      // Defensive: gate critic returned `amend` but flagged no tasks. The
      // brief treats this as a contradiction; surface it loudly rather
      // than silently treating it as a pass.
      throw new Error(
        `amendment loop: gate verdict status is "amend" but no per-task entry is blocking at level ${String(options.level)}`,
      );
    }

    run = applyNewTestsToTaskFiles(run, blockingTaskIds, perTaskVerdicts);
    run = bumpRoundCounters(run, blockingTaskIds);
    run = setTaskStatuses(run, blockingTaskIds, "fixing");

    for (const taskId of blockingTaskIds) {
      const task = requireTask(run, taskId);
      if (task.amendmentRoundsTotal >= AMENDMENT_ESCALATE_ROUND) {
        const resolution = await options.awaitOperatorResolution(
          `task ${taskId} has reached amendment round ${String(task.amendmentRoundsTotal)} at level ${String(options.level)}; operator decision required`,
        );
        if (resolution === "abort") {
          return { run, finalGateVerdict: gateVerdict, outcome: "abort" };
        }
      } else if (task.amendmentRoundsTotal === AMENDMENT_NOTIFY_ROUND) {
        const notify = options.notify;
        if (notify !== undefined) {
          notify(
            `task ${taskId} is at amendment round ${String(AMENDMENT_NOTIFY_ROUND)} at level ${String(options.level)}`,
          );
        }
      }
    }

    await runFixAgents({
      run,
      blockingTaskIds,
      perTaskVerdicts,
      fixAgentRunner: options.fixAgentRunner,
    });

    run = await options.rebuildLevel(run, options.level);
    // After the rebuild callback re-commits the level, the amended tasks
    // are back in `committed` status. The rebuild callback owns commit
    // creation, not status reconciliation, so reset here.
    run = setTaskStatuses(run, blockingTaskIds, "committed");

    const nextRound = gateVerdict.round + 1;
    const taskIdsInLevel = run.tasks
      .filter((t) => t.level === options.level)
      .map((t) => t.id);
    const critiqueEligibleIds = taskIdsInLevel.filter((id) => {
      const t = requireTask(run, id);
      return isCritiquedTask(t);
    });

    const nextPerTaskVerdicts = new Map<string, CritiqueVerdict>();
    for (const taskId of critiqueEligibleIds) {
      const verdict = await options.criticRunner({
        run,
        task: requireTask(run, taskId),
        level: options.level,
        round: nextRound,
      });
      nextPerTaskVerdicts.set(taskId, verdict);
      run = appendCritiqueVerdict(run, taskId, verdict);
    }

    const nextGateVerdict = await options.gateCriticRunner({
      run,
      level: options.level,
      round: nextRound,
      perTaskVerdicts: Array.from(nextPerTaskVerdicts.entries()).map(
        ([taskId, v]) => ({ taskId, verdict: v }),
      ),
    });

    run = appendGateVerdict(run, nextGateVerdict);
    gateVerdict = nextGateVerdict;
    perTaskVerdicts = nextPerTaskVerdicts;
  }
}

function collectBlockingTaskIds(verdict: GateVerdict): string[] {
  const ids: string[] = [];
  for (const [taskId, perTask] of Object.entries(verdict.perTask)) {
    if (perTask.status === "amend" || perTask.status === "fail") {
      ids.push(taskId);
    } else if (hasBlockingFinding(perTask)) {
      ids.push(taskId);
    }
  }
  return ids.sort();
}

function hasBlockingFinding(perTask: PerTaskGateVerdict): boolean {
  return perTask.findings.some((f) => f.severity === "blocking");
}

function isCritiquedTask(task: Task): boolean {
  switch (task.agentType) {
    case "general":
      return true;
    case "explore":
      return false;
    case "intern":
      return task.critiqueEnabled;
  }
}

function requireTask(run: Run, taskId: string): Task {
  const task = run.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    throw new Error(`amendment loop: task "${taskId}" not present in run`);
  }
  return task;
}

function updateTask(run: Run, taskId: string, mutate: (task: Task) => Task): Run {
  let found = false;
  const tasks = run.tasks.map((t) => {
    if (t.id !== taskId) return t;
    found = true;
    return mutate(t);
  });
  if (!found) {
    throw new Error(`amendment loop: task "${taskId}" not present in run`);
  }
  return { ...run, tasks };
}

function applyNewTestsToTaskFiles(
  run: Run,
  taskIds: readonly string[],
  perTaskVerdicts: ReadonlyMap<string, CritiqueVerdict>,
): Run {
  let next = run;
  for (const taskId of taskIds) {
    const verdict = perTaskVerdicts.get(taskId);
    if (verdict === undefined) continue;
    if (verdict.newTests.length === 0) continue;
    next = updateTask(next, taskId, (task) => {
      if (task.output === null) {
        throw new Error(
          `amendment loop: task "${taskId}" has no output yet but a critique verdict declared newTests`,
        );
      }
      const merged = mergeUnique(task.output.filesModified, verdict.newTests);
      return {
        ...task,
        output: { ...task.output, filesModified: merged },
      };
    });
  }
  return next;
}

function mergeUnique(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(base);
  const out = [...base];
  for (const item of extra) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function bumpRoundCounters(run: Run, taskIds: readonly string[]): Run {
  let next = run;
  for (const taskId of taskIds) {
    next = updateTask(next, taskId, (task) => ({
      ...task,
      amendmentRoundsTotal: task.amendmentRoundsTotal + 1,
    }));
  }
  return next;
}

function setTaskStatuses(
  run: Run,
  taskIds: readonly string[],
  status: Task["status"],
): Run {
  let next = run;
  for (const taskId of taskIds) {
    next = updateTask(next, taskId, (task) => {
      if (status === "fixing") {
        return { ...task, status, fixingSource: "critique" };
      }
      if (status === "committed") {
        return { ...task, status, fixingSource: null };
      }
      return { ...task, status };
    });
  }
  return next;
}

function appendCritiqueVerdict(
  run: Run,
  taskId: string,
  verdict: CritiqueVerdict,
): Run {
  return updateTask(run, taskId, (task) => ({
    ...task,
    critiqueVerdicts: [...task.critiqueVerdicts, verdict],
  }));
}

function appendGateVerdict(run: Run, verdict: GateVerdict): Run {
  return { ...run, gateVerdicts: [...run.gateVerdicts, verdict] };
}

function markCommittedTasksCompleted(run: Run, level: number): Run {
  const tasks = run.tasks.map((t) => {
    if (t.level !== level) return t;
    if (t.status !== "committed" && t.status !== "critiquing") return t;
    return { ...t, status: "completed" as Task["status"], fixingSource: null };
  });
  return { ...run, tasks };
}

interface RunFixAgentsInput {
  readonly run: Run;
  readonly blockingTaskIds: readonly string[];
  readonly perTaskVerdicts: ReadonlyMap<string, CritiqueVerdict>;
  readonly fixAgentRunner: FixAgentRunner;
}

async function runFixAgents(input: RunFixAgentsInput): Promise<void> {
  const jobs = input.blockingTaskIds.map(async (taskId) => {
    const task = input.run.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      throw new Error(`amendment loop: task "${taskId}" not present in run`);
    }
    const verdict = input.perTaskVerdicts.get(taskId);
    const findings: readonly Finding[] = verdict?.findings ?? [];
    await input.fixAgentRunner({
      run: input.run,
      task,
      findings,
    });
  });
  await Promise.all(jobs);
}
