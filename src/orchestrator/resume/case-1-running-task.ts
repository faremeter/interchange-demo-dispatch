// Case 1 — Mid-task implementer agent.
//
// State evidence: a task at status `running` AND an `agent-ctx/` directory
// exists under `<runDir>/tasks/<taskId>/agent-ctx/`. The agent process is
// gone (orchestrator crash) but its context lives on disk; per the spec's
// `lock.ts` rule we kill the context and re-spawn from the seed.
//
// Recovery:
//
//   1. Remove `<runDir>/tasks/<taskId>/agent-ctx/` entirely.
//   2. Reset `task.status` to `pending`. The next forward pass through
//      `runLevel` will re-fan-out the task from the seed message.
//
// Disambiguation from case 2: case 1 fires when `running` AND agent-ctx
// exists AND the task's `output.yaml` is **absent**. If `output.yaml` is
// present too, it's case 2 (between submitOutput and state-file write).

import { join } from "node:path";

import type { Run, Task } from "../../state/index.js";
import { pathExists, withTask, type ResumeFsHooks } from "../resume.js";

export async function detectCase1Tasks(
  run: Run,
  runDir: string,
): Promise<string[]> {
  const matched: string[] = [];
  for (const task of run.tasks) {
    if (task.status !== "running") continue;
    const taskDir = taskDirOf(runDir, task);
    const agentCtxPath = join(taskDir, "agent-ctx");
    const outputPath = join(taskDir, "output.yaml");
    const [hasCtx, hasOutput] = await Promise.all([
      pathExists(agentCtxPath),
      pathExists(outputPath),
    ]);
    // Case 1 specifically excludes case 2 (output.yaml present). If both
    // are present, case 2 wins and case 1 stays silent — the resume entry
    // point's multi-match check then sees only one case.
    if (hasCtx && !hasOutput) {
      matched.push(task.id);
    }
  }
  return matched;
}

export async function recoverCase1(
  run: Run,
  runDir: string,
  taskIds: readonly string[],
  hooks: ResumeFsHooks,
): Promise<Run> {
  let next = run;
  for (const taskId of taskIds) {
    const task = requireTask(next, taskId);
    const taskDir = taskDirOf(runDir, task);
    const agentCtxPath = join(taskDir, "agent-ctx");
    await hooks.runRemove(agentCtxPath);
    next = withTask(next, taskId, (t) => ({
      ...t,
      status: "pending" as Task["status"],
    }));
  }
  return next;
}

function taskDirOf(runDir: string, task: Task): string {
  return join(runDir, "tasks", task.id);
}

function requireTask(run: Run, taskId: string): Task {
  const task = run.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    throw new Error(`resume case-1: task "${taskId}" missing from run "${run.name}"`);
  }
  return task;
}
