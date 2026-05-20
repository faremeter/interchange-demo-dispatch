// Level enumeration helper for `runDispatch`.
//
// Returns the sorted unique list of `Task.level` values present in a run.
// `runDispatch` iterates over this list so it can drive runLevel -> commit
// -> gate per level in ascending order, independent of how many tasks
// inhabit each level.

import type { Run } from "../state/index.js";

/**
 * Sorted list of distinct `Task.level` values appearing in `run.tasks`.
 *
 * Returns an empty array when the run has no tasks (e.g. when the
 * planner produced an empty plan). The orchestrator treats that as a
 * loud failure at its layer; this helper does not.
 */
export function levelsOf(run: Run): number[] {
  const seen = new Set<number>();
  for (const task of run.tasks) seen.add(task.level);
  return Array.from(seen).sort((a, b) => a - b);
}
