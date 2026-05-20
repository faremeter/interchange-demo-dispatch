// Case 4 — Mid-rebuild between commits within a level.
//
// State evidence: a level L has some-but-not-all tasks whose `commitSHA`
// values appear in `git log` from `levelBoundaries[L]`. The orchestrator
// crashed after writing some commit SHAs to state but before the rebuild
// could finish. Per spec.md §658-§663:
//
//   "Walk `git log` from `levelBoundaries[level]`; resume rebuild from
//    the first task whose `commitSHA` doesn't appear in the log."
//
// Recovery:
//
//   1. For each affected level L: walk `git log levelBoundaries[L]..HEAD`.
//   2. Identify the first task in `orderedTaskIds` for L whose recorded
//      `commitSHA` is not present in that log.
//   3. Reset that task and every later task at level L back to
//      `submitted` (so the rebuild restarts from the right point). Their
//      `commitSHA` is cleared to `null` to remove the stale reference.
//   4. The next forward pass through `commitLevel(level)` will re-iterate
//      the level's tasks; ones that are already `committed` (with a SHA
//      reachable from HEAD) are skipped.
//
// Worktree path: every task at level L shares one worktree path (enforced
// by `commitLevel`'s `resolveWorktreePath`). We pick the first non-null
// `task.worktreePath` for the level and use it as the cwd.
//
// `levelBoundaries[L]` is the pre-level-L boundary; the 5b/5c fix that
// landed before this task (output.yaml dev-2) corrected the read index to
// `[level]` (not `[level - 1]`). We rely on that fix here.

import type { Run, Task } from "../../state/index.js";
import { orderedTaskIds } from "../attribution.js";
import type { GitExecutor } from "../worktree.js";
import { gitLogFromBoundary } from "../resume.js";

export interface Case4Detection {
  readonly level: number;
  /** Task ids at this level, in commit order, that need their SHA cleared. */
  readonly taskIdsToReset: readonly string[];
}

export interface Case4Deps {
  readonly gitExecutor: GitExecutor;
}

export async function detectCase4Levels(
  run: Run,
  deps: Case4Deps,
): Promise<string[]> {
  const detections = await collectCase4Detections(run, deps);
  return detections.map((d) => `level=${String(d.level)}:${d.taskIdsToReset.join("/")}`);
}

export async function recoverCase4(
  run: Run,
  evidence: readonly string[],
): Promise<Run> {
  if (evidence.length === 0) return run;
  // The detection encoded `level=N:t1/t2/...`. Reapply directly from the
  // encoded list — re-running the detector here would double the git
  // executor calls and risk drift; encode-once-apply-once is the safer
  // shape.
  const parsedDetections = evidence.map(parseCase4EvidenceItem);
  let next = run;
  for (const detection of parsedDetections) {
    next = applyDetection(next, detection);
  }
  return next;
}

async function collectCase4Detections(
  run: Run,
  deps: Case4Deps,
): Promise<Case4Detection[]> {
  const detections: Case4Detection[] = [];
  const levelsToCheck = collectLevelsToCheck(run);

  for (const level of levelsToCheck) {
    const levelTasks = run.tasks.filter((t) => t.level === level);
    const ordered = orderedTaskIds(levelTasks);
    const tasksById = new Map(levelTasks.map((t) => [t.id, t]));

    const boundarySHA = run.levelBoundaries[level];
    if (boundarySHA === undefined) continue;

    const worktreePath = pickWorktreePath(levelTasks);
    if (worktreePath === null) continue;

    const log = await gitLogFromBoundary(worktreePath, boundarySHA, deps.gitExecutor);
    const reachable = new Set(log);

    let firstMissingIdx = -1;
    for (let i = 0; i < ordered.length; i++) {
      const taskId = ordered[i];
      if (taskId === undefined) continue;
      const task = tasksById.get(taskId);
      if (task === undefined) continue;
      if (task.commitSHA === null) {
        // Zero-file commit unit (or freshly-cleared by an earlier resume
        // pass). It does not appear in the log by design; skip it.
        continue;
      }
      if (!reachable.has(task.commitSHA)) {
        firstMissingIdx = i;
        break;
      }
    }
    if (firstMissingIdx === -1) continue;

    const allCommittedAtLevel = levelTasks.every(
      (t) => t.status === "committed" || t.status === "critiquing",
    );
    if (!allCommittedAtLevel) {
      // Not a case-4 hit — some tasks are still mid-flight pre-commit.
      // Case 1/2/3 will catch those; we don't double-count here.
      continue;
    }

    const taskIdsToReset = ordered.slice(firstMissingIdx).filter((id): id is string => id !== undefined);
    detections.push({ level, taskIdsToReset });
  }

  return detections;
}

function collectLevelsToCheck(run: Run): number[] {
  // Case 4 only fires while a level is between commit and gate
  // (`committed` / `critiquing`). Once tasks reach `completed`, the
  // level passed gate and the rebuild can't be mid-flight any more —
  // it would have failed gate first. Restricting the set keeps us
  // from walking git log on long-since-finalized levels.
  const levels = new Set<number>();
  for (const task of run.tasks) {
    if (task.status === "committed" || task.status === "critiquing") {
      levels.add(task.level);
    }
  }
  return Array.from(levels).sort((a, b) => a - b);
}

function pickWorktreePath(levelTasks: readonly Task[]): string | null {
  for (const task of levelTasks) {
    if (task.worktreePath !== null) return task.worktreePath;
  }
  return null;
}

function applyDetection(run: Run, detection: Case4Detection): Run {
  const resetIds = new Set(detection.taskIdsToReset);
  const tasks = run.tasks.map((t) => {
    if (t.level !== detection.level) return t;
    if (!resetIds.has(t.id)) return t;
    return {
      ...t,
      status: "submitted" as Task["status"],
      commitSHA: null,
    };
  });
  return { ...run, tasks };
}

function parseCase4EvidenceItem(item: string): Case4Detection {
  const match = /^level=(\d+):(.*)$/.exec(item);
  if (match === null) {
    throw new Error(`resume case-4: malformed evidence string "${item}"`);
  }
  const levelText = match[1];
  const taskList = match[2];
  if (levelText === undefined || taskList === undefined) {
    throw new Error(`resume case-4: malformed evidence string "${item}"`);
  }
  const level = Number.parseInt(levelText, 10);
  if (Number.isNaN(level)) {
    throw new Error(`resume case-4: non-numeric level in evidence "${item}"`);
  }
  const taskIds = taskList.split("/").filter((s) => s.length > 0);
  return { level, taskIdsToReset: taskIds };
}
