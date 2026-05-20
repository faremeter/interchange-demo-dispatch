// Phase-5 step 4: per-task fix phase.
//
// Each task the attribution agent named runs through a fix-agent
// invocation serialized in topological order (lexicographic on task
// id, matching the attribution module's convention — spec.md §537).
// The orchestrator:
//
//   1. Transitions the task `committed -> fixing` and sets
//      `fixingSource: "verification"`.
//   2. Increments `verificationFixRoundsTotal`.
//   3. Checks the round counter:
//        - exactly equal to `VERIFICATION_NOTIFY_ROUND` -> notify().
//        - greater than or equal to `VERIFICATION_ESCALATE_ROUND` ->
//          ask the operator via `awaitOperatorResolution`. If the
//          operator chooses `abort`, the loop short-circuits with
//          `outcome: "abort"`.
//   4. Invokes the injected `fixAgentRunner` with the task, the
//      attributed failures, and the committed-diff text. The runner
//      handles spawning / closing the fix agent — this module never
//      touches `@intx/agent` directly. (Same pattern as 5d's
//      `runAmendmentLoop` invokes its `fixAgentRunner`.)
//   5. The runner returns the agent's submitted output. The fix
//      phase merges `filesModified` into the task's
//      `output.filesModified` so the subsequent rebuild picks up
//      newly-touched files.
//   6. Re-runs the task's `verifyCommands` via the injected
//      `taskVerifier`. If the verifier reports failure, the fix
//      agent gets another turn (the spec's "fix agent gets another
//      turn" rule in §556-§558) up to a per-task retry cap. If it
//      can't recover, the task transitions to `failed` and the
//      whole run is escalated.
//
// Reset on success: after the loop, every fixed task is left in
// `committed` status with `fixingSource: null`. The rebuild step (5)
// will re-stamp `commitSHA`; the gate step (6) will re-stamp
// `critiqueVerdicts`. The fix phase deliberately does NOT touch
// `commitSHA` — `null`-ing it here would lose information that the
// rebuild needs to compare against the actual git history.

import type {
  BuildFailure,
  Finding,
  Run,
  Task,
} from "../../state/index.js";

import type { OperatorResolutionCallback } from "../gate.js";

export const VERIFICATION_NOTIFY_ROUND = 3;
export const VERIFICATION_ESCALATE_ROUND = 4;

/**
 * Round at which `verificationFixRoundsTotal` triggers a notify
 * (matches `amendmentRoundsTotal`'s threshold — spec.md §611-§621).
 */
export const PHASE5_NOTIFY_ROUND = VERIFICATION_NOTIFY_ROUND;
/**
 * Round at which `verificationFixRoundsTotal` triggers the operator
 * escape hatch. Same as `amendmentRoundsTotal`'s threshold.
 */
export const PHASE5_ESCALATE_ROUND = VERIFICATION_ESCALATE_ROUND;

export interface FixAgentInput {
  readonly run: Run;
  readonly task: Task;
  /** Attributed failures for the task, derived from the round's attribution. */
  readonly failures: readonly BuildFailure[];
  /** Findings projection of the failures, for unified seed-rendering. */
  readonly findings: readonly Finding[];
  /** `git show <commitSHA>` text for the task's commit. Empty for zero-file units. */
  readonly committedDiff: string;
}

/**
 * Run a fix agent for one task. Tests pass scripted runners that
 * resolve immediately; production wires this to
 * `createFixAgent + send + awaitSubmitOutput + close`.
 *
 * Returns the agent's submitted output. The orchestrator merges
 * `filesModified` into the task's persisted output.
 */
export type Phase5FixAgentRunner = (
  input: FixAgentInput,
) => Promise<{
  /** Files the fix agent touched; deduped + merged into task.output.filesModified. */
  readonly filesModified: readonly string[];
}>;

export interface TaskVerifierInput {
  readonly run: Run;
  readonly task: Task;
}

export interface TaskVerifierResult {
  readonly ok: boolean;
  /** Combined stdout+stderr text from the per-task verify commands. */
  readonly output: string;
}

/**
 * Run a single task's `verifyCommands` and report whether they
 * pass. The runner is injectable so tests can script outcomes
 * deterministically. Production callers wire this to a
 * shell-spawn helper analogous to `baseline.ts`'s `spawnCombined`.
 */
export type TaskVerifier = (input: TaskVerifierInput) => Promise<TaskVerifierResult>;

export interface RunFixPhaseOptions {
  readonly run: Run;
  /**
   * `failureId -> taskIds[]` map from the attribution agent. Every
   * task id present here is fixed in lex order.
   */
  readonly attribution: Record<string, string[]>;
  /**
   * `failureId -> BuildFailure` lookup. Built once by the engine
   * from the round's new failures.
   */
  readonly failuresById: ReadonlyMap<string, BuildFailure>;
  /**
   * `taskId -> committedDiff` lookup. Built once by the engine
   * from `git show <commitSHA>`. A zero-file commit unit maps to "".
   */
  readonly committedDiffsByTaskId: ReadonlyMap<string, string>;
  readonly fixAgentRunner: Phase5FixAgentRunner;
  readonly taskVerifier: TaskVerifier;
  readonly awaitOperatorResolution: OperatorResolutionCallback;
  /**
   * Optional logger sink for the round-3 notice. Same convention as
   * `runAmendmentLoop`'s `notify`.
   */
  readonly notify?: (message: string) => void;
  /**
   * Maximum fix-agent retries per task within one Phase-5 fix-loop
   * iteration. Defaults to 1 (one fix attempt; if it fails, fail the
   * task and escalate). Tests typically override.
   */
  readonly maxRetriesPerTask?: number;
}

export interface RunFixPhaseResult {
  readonly run: Run;
  /**
   * Outcome of the per-task fix phase:
   *   - `clean`: every task's verifier reported `ok`.
   *   - `task-failed`: at least one task could not recover and was
   *     marked `failed`. The engine treats this as an escalation.
   *   - `operator-abort`: a per-task escalation was answered with
   *     `abort`. The engine surfaces this to its caller.
   */
  readonly outcome: "clean" | "task-failed" | "operator-abort";
  /** Ids of tasks that ended the phase in `failed` status. */
  readonly failedTaskIds: readonly string[];
}

/**
 * Drive the per-task fix phase (spec.md §536-§559). See file header
 * for the full sequence.
 */
export async function runFixPhase(
  options: RunFixPhaseOptions,
): Promise<RunFixPhaseResult> {
  const maxRetries = options.maxRetriesPerTask ?? 1;
  const taskOrder = collectTargetTaskIds(options.attribution);
  let working = options.run;
  const failedTaskIds: string[] = [];

  for (const taskId of taskOrder) {
    working = setTaskStatus(working, taskId, "fixing", "verification");
    working = bumpVerificationFixRound(working, taskId);

    const taskAfter = requireTask(working, taskId);
    if (taskAfter.verificationFixRoundsTotal >= PHASE5_ESCALATE_ROUND) {
      const resolution = await options.awaitOperatorResolution(
        `task ${taskId} has reached verification-fix round ${String(taskAfter.verificationFixRoundsTotal)}; operator decision required`,
      );
      if (resolution === "abort") {
        return {
          run: working,
          outcome: "operator-abort",
          failedTaskIds: [],
        };
      }
    } else if (taskAfter.verificationFixRoundsTotal === PHASE5_NOTIFY_ROUND) {
      const notify = options.notify;
      if (notify !== undefined) {
        notify(
          `task ${taskId} is at verification-fix round ${String(PHASE5_NOTIFY_ROUND)}`,
        );
      }
    }

    const failureIds = collectFailureIdsForTask(options.attribution, taskId);
    const failures = failureIds.map((id) => requireFailure(options.failuresById, id));
    const findings = failures.map((f, idx) => failureAsFinding(f, idx, taskId));
    const committedDiff = options.committedDiffsByTaskId.get(taskId) ?? "";

    let recovered = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const agentResult = await options.fixAgentRunner({
        run: working,
        task: requireTask(working, taskId),
        failures,
        findings,
        committedDiff,
      });
      working = mergeFilesModified(working, taskId, agentResult.filesModified);

      const verifyResult = await options.taskVerifier({
        run: working,
        task: requireTask(working, taskId),
      });
      if (verifyResult.ok) {
        recovered = true;
        break;
      }
    }

    if (!recovered) {
      working = setTaskStatus(working, taskId, "failed", null);
      failedTaskIds.push(taskId);
      continue;
    }

    working = setTaskStatus(working, taskId, "committed", null);
  }

  if (failedTaskIds.length > 0) {
    return { run: working, outcome: "task-failed", failedTaskIds };
  }
  return { run: working, outcome: "clean", failedTaskIds: [] };
}

function collectTargetTaskIds(
  attribution: Record<string, string[]>,
): string[] {
  const seen = new Set<string>();
  for (const ids of Object.values(attribution)) {
    for (const id of ids) seen.add(id);
  }
  return Array.from(seen).sort();
}

function collectFailureIdsForTask(
  attribution: Record<string, string[]>,
  taskId: string,
): string[] {
  const out: string[] = [];
  for (const [failureId, ids] of Object.entries(attribution)) {
    if (ids.includes(taskId)) out.push(failureId);
  }
  out.sort();
  return out;
}

function requireTask(run: Run, taskId: string): Task {
  const task = run.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    throw new Error(`fix phase: task "${taskId}" not present in run`);
  }
  return task;
}

function requireFailure(
  failuresById: ReadonlyMap<string, BuildFailure>,
  failureId: string,
): BuildFailure {
  const f = failuresById.get(failureId);
  if (f === undefined) {
    throw new Error(`fix phase: failure "${failureId}" not in failuresById map`);
  }
  return f;
}

function failureAsFinding(
  failure: BuildFailure,
  index: number,
  taskId: string,
): Finding {
  return {
    id: `${taskId}-verif-${String(index + 1)}-${failure.id}`,
    severity: "blocking",
    description: failure.message,
    filePath: failure.file,
    lineRange: failure.line === null ? null : [failure.line, failure.line],
  };
}

function setTaskStatus(
  run: Run,
  taskId: string,
  status: Task["status"],
  fixingSource: Task["fixingSource"],
): Run {
  let found = false;
  const tasks = run.tasks.map((t) => {
    if (t.id !== taskId) return t;
    found = true;
    return { ...t, status, fixingSource };
  });
  if (!found) {
    throw new Error(`fix phase: task "${taskId}" not present in run`);
  }
  return { ...run, tasks };
}

function bumpVerificationFixRound(run: Run, taskId: string): Run {
  let found = false;
  const tasks = run.tasks.map((t) => {
    if (t.id !== taskId) return t;
    found = true;
    return {
      ...t,
      verificationFixRoundsTotal: t.verificationFixRoundsTotal + 1,
    };
  });
  if (!found) {
    throw new Error(`fix phase: task "${taskId}" not present in run`);
  }
  return { ...run, tasks };
}

function mergeFilesModified(
  run: Run,
  taskId: string,
  newFiles: readonly string[],
): Run {
  let found = false;
  const tasks = run.tasks.map((t) => {
    if (t.id !== taskId) return t;
    found = true;
    if (t.output === null) {
      throw new Error(
        `fix phase: task "${taskId}" has no output; cannot merge filesModified`,
      );
    }
    const seen = new Set(t.output.filesModified);
    const merged = [...t.output.filesModified];
    for (const f of newFiles) {
      if (seen.has(f)) continue;
      seen.add(f);
      merged.push(f);
    }
    return { ...t, output: { ...t.output, filesModified: merged } };
  });
  if (!found) {
    throw new Error(`fix phase: task "${taskId}" not present in run`);
  }
  return { ...run, tasks };
}
