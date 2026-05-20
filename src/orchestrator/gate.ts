// Per-level gate.
//
// `gate(run, level, options)` runs the critique step for one level of a
// run, per spec.md §588-§610:
//
//   1. Per-task critique fans out in parallel across the level's
//      critique-enabled tasks (rules in `critique-enablement.ts`,
//      matching spec.md §449-§450).
//   2. Once all per-task critiques are in, the per-level gate critic
//      runs once and emits a `GateVerdict`.
//   3. On `pass`, every `committed` task in the level transitions to
//      `completed`; on `amend`, the bounded amendment loop drives fix
//      agents + rebuild + re-critique until the gate clears, the gate
//      critic returns `fail`, or the operator aborts.
//
// Cross-task type independence:
//
//   The amendment loop needs to invoke `5c-commit-level`'s rebuild
//   helper to redo the level's commits after fix agents have edited
//   files. To keep this task's code type-independent of 5c, `gate.ts`
//   declares a `RebuildCallback` shape locally and consumes it through
//   the `options` parameter. `7a-orchestrator-loop` will pass
//   `rebuildLevelFromBoundary` (or whatever name 5c lands) at runtime;
//   that function must structurally satisfy `RebuildCallback`.
//
// Operator escalation:
//
//   When a task's `amendmentRoundsTotal` reaches 4+, the loop blocks on
//   the `awaitOperatorResolution` callback. The orchestrator binds this
//   to `5b-run-level`'s file-watch escape hatch at wire time; this
//   module owns no file I/O.
//
// PoC scope: spec.md does not require mutation testing / `validate-fix`
// (see `4a-critic-surfaces` notes). Gate verdicts pass through without
// those fields.

import type {
  CritiqueVerdict,
  Finding,
  GateOutcome,
  GateVerdict,
  PerTaskGateVerdict,
  Run,
  Task,
} from "../state/index.js";

import { isCritiqueEnabled } from "./critique-enablement.js";
import { runAmendmentLoop } from "./amendment-loop.js";

/**
 * Callback shape `5c-commit-level`'s rebuild helper must satisfy.
 * Declared here so 5d can depend only on the shape, not on 5c's module.
 * `7a-orchestrator-loop` wires the real function at runtime.
 */
export type RebuildCallback = (run: Run, fromLevel: number) => Promise<Run>;

/**
 * Callback shape for the operator escape hatch. `5b-run-level` exports a
 * concrete implementation that file-watches a `pending-escalation.yaml`
 * in the run directory; the orchestrator partial-applies the runDir
 * before passing the callback here so the gate code stays decoupled from
 * the file layout.
 */
export type OperatorResolutionCallback = (
  reason: string,
) => Promise<"continue" | "abort">;

export interface CriticRunnerInput {
  readonly run: Run;
  readonly task: Task;
  readonly level: number;
  readonly round: number;
}

export type CriticRunner = (input: CriticRunnerInput) => Promise<CritiqueVerdict>;

export interface GateCriticRunnerInput {
  readonly run: Run;
  readonly level: number;
  readonly round: number;
  readonly perTaskVerdicts: readonly {
    readonly taskId: string;
    readonly verdict: CritiqueVerdict;
  }[];
}

export type GateCriticRunner = (
  input: GateCriticRunnerInput,
) => Promise<GateVerdict>;

export interface FixAgentRunnerInput {
  readonly run: Run;
  readonly task: Task;
  readonly findings: readonly Finding[];
}

export type FixAgentRunner = (input: FixAgentRunnerInput) => Promise<void>;

export interface GateOptions {
  readonly criticRunner: CriticRunner;
  readonly gateCriticRunner: GateCriticRunner;
  readonly fixAgentRunner: FixAgentRunner;
  readonly rebuildLevel: RebuildCallback;
  readonly awaitOperatorResolution: OperatorResolutionCallback;
  /**
   * Optional notify sink used by the amendment loop at the round-3
   * boundary. Production callers wire a real logger; tests may omit it.
   */
  readonly notify?: (message: string) => void;
}

export interface GateResult {
  readonly run: Run;
  readonly gateVerdict: GateVerdict;
  readonly outcome: "pass" | "abort" | "fail";
}

export async function gate(
  run: Run,
  level: number,
  options: GateOptions,
): Promise<GateResult> {
  const tasksInLevel = run.tasks.filter((t) => t.level === level);
  if (tasksInLevel.length === 0) {
    throw new Error(`gate: no tasks at level ${String(level)}`);
  }

  const committedIds = tasksInLevel
    .filter((t) => t.status === "committed")
    .map((t) => t.id);
  if (committedIds.length !== tasksInLevel.length) {
    const blockingIds = tasksInLevel
      .filter((t) => t.status !== "committed")
      .map((t) => `${t.id}=${t.status}`)
      .join(", ");
    throw new Error(
      `gate: every task at level ${String(level)} must be "committed" before the gate runs; non-committed: ${blockingIds}`,
    );
  }

  let nextRun = setTaskStatusesAtLevel(run, level, "critiquing");

  const initialRound = 1;
  const critiquedTasks = tasksInLevel.filter(isCritiqueEnabled);
  const skippedTasks = tasksInLevel.filter((t) => !isCritiqueEnabled(t));

  const perTaskVerdicts = new Map<string, CritiqueVerdict>();
  for (const task of critiquedTasks) {
    const verdict = await options.criticRunner({
      run: nextRun,
      task,
      level,
      round: initialRound,
    });
    perTaskVerdicts.set(task.id, verdict);
    nextRun = appendCritiqueVerdict(nextRun, task.id, verdict);
  }

  // Tasks where critique is disabled get a synthesized `pass` per-task
  // entry so the gate critic's input is dense. spec.md §449-§450 treats
  // disabled-critique tasks as implicitly accepted at the gate.
  const synthesizedPasses: { taskId: string; verdict: CritiqueVerdict }[] =
    skippedTasks.map((t) => ({
      taskId: t.id,
      verdict: {
        round: initialRound,
        status: "pass",
        findings: [],
        newTests: [],
      } satisfies CritiqueVerdict,
    }));

  const perTaskEntries: { taskId: string; verdict: CritiqueVerdict }[] = [
    ...Array.from(perTaskVerdicts.entries()).map(([taskId, verdict]) => ({
      taskId,
      verdict,
    })),
    ...synthesizedPasses,
  ];

  let gateVerdict: GateVerdict;
  if (critiquedTasks.length === 0) {
    // No tasks needed critique — skip the gate critic entirely and
    // synthesize a clean gate verdict. (PoC never hits this in practice
    // because there are no explore agents, but the predicate's contract
    // requires we handle it.)
    gateVerdict = {
      level,
      round: initialRound,
      status: "pass",
      perTask: buildPerTaskRecord(perTaskEntries),
    };
  } else {
    gateVerdict = await options.gateCriticRunner({
      run: nextRun,
      level,
      round: initialRound,
      perTaskVerdicts: perTaskEntries,
    });
  }
  nextRun = appendGateVerdict(nextRun, gateVerdict);

  // Skipped-critique tasks pass straight through to completed once the
  // gate clears them (or trivially if the gate is unanimously pass).
  nextRun = setSkippedTasksCompleted(nextRun, level, skippedTasks);

  if (gateVerdict.status === "pass") {
    nextRun = markCommittedTasksCompleted(nextRun, level);
    return { run: nextRun, gateVerdict, outcome: "pass" };
  }

  if (gateVerdict.status === "fail") {
    return { run: nextRun, gateVerdict, outcome: "fail" };
  }

  const loopResult = await runAmendmentLoop({
    run: nextRun,
    level,
    initialGateVerdict: gateVerdict,
    initialPerTaskVerdicts: perTaskVerdicts,
    criticRunner: options.criticRunner,
    gateCriticRunner: options.gateCriticRunner,
    fixAgentRunner: options.fixAgentRunner,
    rebuildLevel: options.rebuildLevel,
    awaitOperatorResolution: options.awaitOperatorResolution,
    ...(options.notify !== undefined ? { notify: options.notify } : {}),
  });

  return {
    run: loopResult.run,
    gateVerdict: loopResult.finalGateVerdict,
    outcome: loopResult.outcome,
  };
}

function setTaskStatusesAtLevel(
  run: Run,
  level: number,
  status: Task["status"],
): Run {
  const tasks = run.tasks.map((t) =>
    t.level === level && t.status === "committed" ? { ...t, status } : t,
  );
  return { ...run, tasks };
}

function appendCritiqueVerdict(
  run: Run,
  taskId: string,
  verdict: CritiqueVerdict,
): Run {
  const tasks = run.tasks.map((t) =>
    t.id === taskId
      ? { ...t, critiqueVerdicts: [...t.critiqueVerdicts, verdict] }
      : t,
  );
  return { ...run, tasks };
}

function appendGateVerdict(run: Run, verdict: GateVerdict): Run {
  return { ...run, gateVerdicts: [...run.gateVerdicts, verdict] };
}

function buildPerTaskRecord(
  entries: readonly { taskId: string; verdict: CritiqueVerdict }[],
): Record<string, PerTaskGateVerdict> {
  const out: Record<string, PerTaskGateVerdict> = {};
  for (const { taskId, verdict } of entries) {
    out[taskId] = {
      status: verdict.status satisfies GateOutcome,
      findings: verdict.findings,
    };
  }
  return out;
}

function setSkippedTasksCompleted(
  run: Run,
  level: number,
  skipped: readonly Task[],
): Run {
  if (skipped.length === 0) return run;
  const skippedIds = new Set(skipped.map((t) => t.id));
  const tasks = run.tasks.map((t) => {
    if (t.level !== level) return t;
    if (!skippedIds.has(t.id)) return t;
    if (t.status !== "critiquing" && t.status !== "committed") return t;
    return { ...t, status: "completed" as Task["status"] };
  });
  return { ...run, tasks };
}

function markCommittedTasksCompleted(run: Run, level: number): Run {
  const tasks = run.tasks.map((t) => {
    if (t.level !== level) return t;
    if (t.status !== "critiquing" && t.status !== "committed") return t;
    return { ...t, status: "completed" as Task["status"], fixingSource: null };
  });
  return { ...run, tasks };
}
