// DAG validator for proposed planner tasks.
//
// Pure function consumed by both the planner agent role (to gate
// `finalizePlan`) and the orchestrator (to defend the invariant when reading
// a manifest back from disk). Lives in its own module so consumers can call
// it without dragging in `@intx/agent` or any inference machinery.
//
// Validation contract (per spec.md §214-§218):
//   1. Every task id is unique.
//   2. Every entry in `dependsOn` references the id of another proposed task.
//      A task cannot depend on itself.
//   3. The graph is acyclic.
//   4. The computed level for each task equals `1 + max(level of each
//      dependency)`, with leaves (no deps) at level 1. The `level` field the
//      planner declared on the proposed task must match the computed level.
//
// On success the validator returns the full `levels` map so the caller does
// not have to recompute it. On failure it returns every issue found in a
// single pass — partial reporting would make the agent guess what to fix
// next, while full reporting lets it correct multiple problems at once.

export interface ProposedTask {
  readonly id: string;
  readonly level: number;
  readonly dependsOn: readonly string[];
}

export type ValidateResult =
  | { ok: true; levels: Record<string, number> }
  | { ok: false; issues: string[] };

interface MutableTask {
  readonly task: ProposedTask;
  readonly index: number;
}

export function validateDAG(tasks: readonly ProposedTask[]): ValidateResult {
  const issues: string[] = [];

  const byId = new Map<string, MutableTask>();
  const duplicateIds = new Set<string>();
  tasks.forEach((task, index) => {
    if (byId.has(task.id)) {
      duplicateIds.add(task.id);
    } else {
      byId.set(task.id, { task, index });
    }
  });

  for (const id of duplicateIds) {
    issues.push(`duplicate task id "${id}"`);
  }

  for (const task of tasks) {
    if (!Number.isInteger(task.level) || task.level < 1) {
      issues.push(
        `task "${task.id}" has invalid level ${String(task.level)}; level must be a positive integer`,
      );
    }
    const seenDeps = new Set<string>();
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        issues.push(`task "${task.id}" depends on itself`);
        continue;
      }
      if (seenDeps.has(dep)) {
        issues.push(`task "${task.id}" lists dependency "${dep}" more than once`);
        continue;
      }
      seenDeps.add(dep);
      if (!byId.has(dep)) {
        issues.push(
          `task "${task.id}" depends on unknown task id "${dep}"`,
        );
      }
    }
  }

  // If any structural error already disqualifies cycle / level checks, return
  // early — running a topological sort against a graph with missing nodes or
  // duplicate ids would produce noise on top of the real problem.
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const cycleIssues = detectCycles(tasks, byId);
  if (cycleIssues.length > 0) {
    return { ok: false, issues: cycleIssues };
  }

  const computedLevels = computeLevels(tasks, byId);
  const levelIssues: string[] = [];
  for (const task of tasks) {
    const computed = computedLevels.get(task.id);
    if (computed === undefined) {
      // computeLevels assigns every task when there are no cycles, so this
      // branch is unreachable if cycle detection ran without findings.
      levelIssues.push(
        `task "${task.id}" has no computed level — internal invariant violated`,
      );
      continue;
    }
    if (task.level !== computed) {
      levelIssues.push(
        `task "${task.id}" declared level ${String(task.level)} but its dependencies imply level ${String(computed)}`,
      );
    }
  }

  if (levelIssues.length > 0) {
    return { ok: false, issues: levelIssues };
  }

  const levels: Record<string, number> = {};
  for (const [id, level] of computedLevels) {
    levels[id] = level;
  }
  return { ok: true, levels };
}

function detectCycles(
  tasks: readonly ProposedTask[],
  byId: ReadonlyMap<string, MutableTask>,
): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const task of tasks) color.set(task.id, WHITE);

  const issues: string[] = [];
  const reportedCycles = new Set<string>();

  function visit(id: string, stack: string[]): void {
    color.set(id, GRAY);
    stack.push(id);

    const task = byId.get(id)?.task;
    if (task === undefined) {
      stack.pop();
      color.set(id, BLACK);
      return;
    }

    for (const dep of task.dependsOn) {
      const c = color.get(dep);
      if (c === GRAY) {
        const cycleStart = stack.indexOf(dep);
        const cyclePath = stack.slice(cycleStart).concat(dep);
        const key = canonicalCycleKey(cyclePath);
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          issues.push(`cycle detected: ${cyclePath.join(" -> ")}`);
        }
      } else if (c === WHITE) {
        visit(dep, stack);
      }
    }

    stack.pop();
    color.set(id, BLACK);
  }

  for (const task of tasks) {
    if (color.get(task.id) === WHITE) {
      visit(task.id, []);
    }
  }

  return issues;
}

function canonicalCycleKey(cyclePath: readonly string[]): string {
  // The cycle path always starts and ends with the same id; drop the
  // duplicate, then rotate so the lexicographically smallest id appears
  // first. Two DFS visits that hit the same cycle from different entry
  // points produce the same key and are de-duplicated.
  const ring = cyclePath.slice(0, -1);
  let minIdx = 0;
  for (let i = 1; i < ring.length; i++) {
    const candidate = ring[i];
    const current = ring[minIdx];
    if (candidate !== undefined && current !== undefined && candidate < current) {
      minIdx = i;
    }
  }
  const rotated = ring.slice(minIdx).concat(ring.slice(0, minIdx));
  return rotated.join("|");
}

function computeLevels(
  tasks: readonly ProposedTask[],
  byId: ReadonlyMap<string, MutableTask>,
): Map<string, number> {
  const levels = new Map<string, number>();

  function resolve(id: string, stack: Set<string>): number {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) {
      // Cycle detection already passed; this branch is unreachable.
      throw new Error(
        `internal invariant violated: cycle reached computeLevels for "${id}"`,
      );
    }
    stack.add(id);
    const task = byId.get(id)?.task;
    if (task === undefined) {
      throw new Error(
        `internal invariant violated: unknown task id "${id}" reached computeLevels`,
      );
    }
    let depMax = 0;
    for (const dep of task.dependsOn) {
      const depLevel = resolve(dep, stack);
      if (depLevel > depMax) depMax = depLevel;
    }
    stack.delete(id);
    const level = depMax + 1;
    levels.set(id, level);
    return level;
  }

  for (const task of tasks) {
    resolve(task.id, new Set());
  }

  return levels;
}
