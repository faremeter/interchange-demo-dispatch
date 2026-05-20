import type { Task } from "../state/index.js";

/**
 * Compute shared-file attribution for a level's tasks.
 *
 * Tasks at the same level are independent of each other (no `depends-on`
 * edges between siblings), so any topological order is valid. The brief
 * (spec.md §27, §568) resolves the ambiguity by ordering **lexicographically
 * on task ID** and attributing each file to the *last* task in that order
 * which lists it in `filesModified`. Earlier tasks' commit units exclude
 * the file from their `git add`.
 *
 * Returns a record mapping each task ID (every input task is present) to
 * the de-duplicated, lexicographically-sorted list of files that task owns
 * after attribution. A task may map to an empty list — that is the
 * "zero-file commit unit" case the caller must handle by skipping the
 * commit and recording `commitSHA: null`.
 */
export function computeAttribution(tasks: Task[]): Record<string, string[]> {
  const order = orderedTaskIds(tasks);
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Walk the union of all filesModified, deduping per task on the way in.
  // For each file, the owner is the lexicographically-largest task ID that
  // lists it.
  const fileOwner = new Map<string, string>();
  for (const id of order) {
    const task = taskById.get(id);
    if (task === undefined) {
      throw new Error(`internal: task id "${id}" missing from taskById map`);
    }
    if (task.output === null) {
      throw new Error(
        `task "${id}" has no output; computeAttribution requires every task at the level to carry a submitted output with filesModified`,
      );
    }
    const seenInTask = new Set<string>();
    for (const file of task.output.filesModified) {
      if (seenInTask.has(file)) continue;
      seenInTask.add(file);
      const current = fileOwner.get(file);
      if (current === undefined || current < id) {
        fileOwner.set(file, id);
      }
    }
  }

  const attribution: Record<string, string[]> = {};
  for (const id of order) {
    attribution[id] = [];
  }
  for (const [file, owner] of fileOwner) {
    const list = attribution[owner];
    if (list === undefined) {
      throw new Error(`internal: owner "${owner}" missing from attribution`);
    }
    list.push(file);
  }
  for (const id of order) {
    const list = attribution[id];
    if (list === undefined) continue;
    list.sort();
  }

  return attribution;
}

/**
 * Lexicographically-sorted task IDs. Exported so commit-level (and Phase 5
 * rebuilds) can iterate in the same canonical order the attribution function
 * uses internally.
 */
export function orderedTaskIds(tasks: Task[]): string[] {
  const ids = tasks.map((t) => t.id);
  ids.sort();
  return ids;
}
