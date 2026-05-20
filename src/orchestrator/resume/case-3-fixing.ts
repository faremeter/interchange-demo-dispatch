// Case 3 — Fix-agent crashed with uncommitted changes.
//
// State evidence: a task at status `fixing` AND the level worktree has a
// dirty `git status --porcelain`. The fix agent (critique-driven or
// verification-driven, recorded as `task.fixingSource`) edited files but
// never reached `submitOutput`. The orchestrator can't keep those edits —
// they're unattributed and ungated.
//
// Recovery:
//
//   1. Hard-reset the level worktree back to `task.commitSHA`. This wipes
//      the uncommitted edits.
//   2. Leave the task in `fixing` with `fixingSource` unchanged. The next
//      forward pass through the amendment loop (or Phase 5's fix phase)
//      will re-spawn the appropriate fix agent.
//
// `task.commitSHA` may be `null` for zero-file commit units. In that case
// we cannot revert to anything meaningful; the task should not have been
// in `fixing` at all (the amendment loop only enters fix on tasks with
// blocking findings, which require a commit to critique). Surface this
// loudly as a contract violation rather than silently doing nothing.

import type { Run, Task } from "../../state/index.js";
import type { GitExecutor } from "../worktree.js";
import { gitHardReset, gitPorcelainStatus } from "../resume.js";

export interface Case3Detection {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly commitSHA: string;
}

export interface Case3Deps {
  readonly gitExecutor: GitExecutor;
}

export async function detectCase3Tasks(
  run: Run,
  deps: Case3Deps,
): Promise<string[]> {
  const matched: string[] = [];
  for (const task of run.tasks) {
    if (task.status !== "fixing") continue;
    if (task.worktreePath === null) {
      throw new Error(
        `resume case-3: task "${task.id}" is in "fixing" but has no worktreePath; orchestrator forward path must populate it before entering fix`,
      );
    }
    if (task.commitSHA === null) {
      throw new Error(
        `resume case-3: task "${task.id}" is in "fixing" but has no commitSHA to revert to; the fix entry only fires on critique-blocked commits — state is corrupt`,
      );
    }
    const porcelain = await gitPorcelainStatus(task.worktreePath, deps.gitExecutor);
    if (porcelain.trim().length === 0) {
      // The worktree is already clean; no fix-agent edits remain on disk.
      // The task is still in `fixing` — the rebuild + re-critique never
      // completed. Mark this as a case 3 hit so the recovery path re-
      // enters fix (the spec accepts wasted-LLM cost over silent skip).
      matched.push(task.id);
      continue;
    }
    matched.push(task.id);
  }
  return matched;
}

export async function recoverCase3(
  run: Run,
  taskIds: readonly string[],
  deps: Case3Deps,
): Promise<Run> {
  for (const taskId of taskIds) {
    const task = requireTask(run, taskId);
    if (task.worktreePath === null || task.commitSHA === null) {
      // Defensive: detection already enforces non-null; recompute the
      // assertion here so a stray manual call still surfaces loudly.
      throw new Error(
        `resume case-3 recover: task "${taskId}" lacks worktreePath or commitSHA`,
      );
    }
    const porcelain = await gitPorcelainStatus(task.worktreePath, deps.gitExecutor);
    if (porcelain.trim().length !== 0) {
      await gitHardReset(task.worktreePath, task.commitSHA, deps.gitExecutor);
    }
  }
  // The task stays in `fixing`. The forward path (amendment-loop / Phase
  // 5's fix-phase) consumes `task.fixingSource` to decide which fix-agent
  // surface to re-spawn; we deliberately leave that field untouched.
  return run;
}

function requireTask(run: Run, taskId: string): Task {
  const task = run.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    throw new Error(`resume case-3: task "${taskId}" missing from run "${run.name}"`);
  }
  return task;
}
