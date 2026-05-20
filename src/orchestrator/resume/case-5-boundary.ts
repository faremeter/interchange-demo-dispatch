// Case 5 — Between commit and boundary write.
//
// State evidence: every task at level L is `committed` AND each `commitSHA`
// is reachable from the level worktree's HEAD AND `levelBoundaries[L+1]`
// either does not exist or does not match HEAD. The orchestrator wrote
// commits to disk but crashed before persisting the post-level boundary
// (spec.md §664-§666).
//
// Recovery:
//
//   1. For each affected level L: re-read HEAD of the level worktree.
//   2. Set `run.levelBoundaries[L+1]` to that SHA.
//   3. Persist.
//
// Disambiguation from case 4: case 4 fires when at least one of the
// level's `commitSHA`s is NOT reachable from HEAD. Case 5 fires when ALL
// SHAs are reachable but the boundary is missing or stale.
//
// `levelBoundaries` is keyed by string in the persisted YAML (numeric keys
// serialize as strings); we use `String(level + 1)` to read and write.

import type { Run, Task } from "../../state/index.js";
import { orderedTaskIds } from "../attribution.js";
import type { GitExecutor } from "../worktree.js";
import { gitHeadSHA, gitLogFromBoundary } from "../resume.js";

export interface Case5Detection {
  readonly level: number;
  readonly headSHA: string;
}

export interface Case5Deps {
  readonly gitExecutor: GitExecutor;
}

export async function detectCase5Levels(
  run: Run,
  deps: Case5Deps,
): Promise<string[]> {
  const detections = await collectCase5Detections(run, deps);
  return detections.map((d) => `level=${String(d.level)}:head=${d.headSHA}`);
}

export async function recoverCase5(
  run: Run,
  evidence: readonly string[],
  _deps: Case5Deps,
): Promise<Run> {
  if (evidence.length === 0) return run;
  let next = run;
  for (const item of evidence) {
    const detection = parseCase5EvidenceItem(item);
    next = {
      ...next,
      levelBoundaries: {
        ...next.levelBoundaries,
        [detection.level + 1]: detection.headSHA,
      },
    };
  }
  return next;
}

async function collectCase5Detections(
  run: Run,
  deps: Case5Deps,
): Promise<Case5Detection[]> {
  const detections: Case5Detection[] = [];
  const candidateLevels = collectCandidateLevels(run);

  for (const level of candidateLevels) {
    const levelTasks = run.tasks.filter((t) => t.level === level);
    if (levelTasks.length === 0) continue;

    // Cheap pre-filter: if the post-level boundary is already on record,
    // there is nothing for this case to fix at this level. Skip without
    // touching the worktree (which may not even exist on disk for
    // already-completed levels).
    if (run.levelBoundaries[level + 1] !== undefined) continue;

    const ordered = orderedTaskIds(levelTasks);
    const tasksById = new Map(levelTasks.map((t) => [t.id, t]));

    const boundarySHA = run.levelBoundaries[level];
    const worktreePath = pickWorktreePath(levelTasks);
    if (worktreePath === null) continue;

    const allCommitted = levelTasks.every(
      (t) => t.status === "committed" || t.status === "completed" || t.status === "critiquing",
    );
    if (!allCommitted) continue;

    let allReachable = true;
    if (boundarySHA !== undefined) {
      const log = await gitLogFromBoundary(worktreePath, boundarySHA, deps.gitExecutor);
      const reachable = new Set(log);
      for (const taskId of ordered) {
        if (taskId === undefined) continue;
        const task = tasksById.get(taskId);
        if (task === undefined || task.commitSHA === null) continue;
        if (!reachable.has(task.commitSHA)) {
          allReachable = false;
          break;
        }
      }
    } else {
      // No pre-level boundary on record. If every task has a non-null
      // commitSHA, the level was fully committed; we still consider this
      // a case-5 hit (the post-level boundary will be HEAD).
      const anyNullSHA = levelTasks.some(
        (t) => t.commitSHA === null && t.status !== "completed",
      );
      if (anyNullSHA) continue;
    }
    if (!allReachable) continue;

    const headSHA = await gitHeadSHA(worktreePath, deps.gitExecutor);
    detections.push({ level, headSHA });
  }

  return detections;
}

function collectCandidateLevels(run: Run): number[] {
  const levels = new Set<number>();
  for (const t of run.tasks) levels.add(t.level);
  return Array.from(levels).sort((a, b) => a - b);
}

function pickWorktreePath(levelTasks: readonly Task[]): string | null {
  for (const t of levelTasks) {
    if (t.worktreePath !== null) return t.worktreePath;
  }
  return null;
}

function parseCase5EvidenceItem(item: string): Case5Detection {
  const match = /^level=(\d+):head=([0-9a-f]+)$/.exec(item);
  if (match === null) {
    throw new Error(`resume case-5: malformed evidence string "${item}"`);
  }
  const levelText = match[1];
  const headSHA = match[2];
  if (levelText === undefined || headSHA === undefined) {
    throw new Error(`resume case-5: malformed evidence string "${item}"`);
  }
  const level = Number.parseInt(levelText, 10);
  if (Number.isNaN(level)) {
    throw new Error(`resume case-5: non-numeric level in evidence "${item}"`);
  }
  return { level, headSHA };
}
