// Case 2 — Between submitOutput and state-file write.
//
// State evidence: a task at status `running` AND its `output.yaml` exists
// on disk. The implementer's terminal-tool resolved (so the orchestrator
// wrote `output.yaml`) but the run-state file did not get re-persisted
// before the crash. The brief accepts the wasted work: we re-spawn the
// agent and discard the on-disk output. No partial submitOutput is trusted.
//
// Recovery:
//
//   1. Remove `<runDir>/tasks/<taskId>/agent-ctx/` (best-effort; the
//      lock.ts rule applies even if the directory is already absent).
//   2. Remove `<runDir>/tasks/<taskId>/output.yaml`.
//   3. Reset `task.status` to `pending` so the next forward pass re-fans.
//
// Disambiguation: detection requires both `running` AND `output.yaml`
// present. If `output.yaml` is absent (only the context dir exists), it's
// case 1. If the task isn't `running`, neither case fires here.

import { join } from "node:path";

import type { Run, Task } from "../../state/index.js";
import { pathExists, withTask, type ResumeFsHooks } from "../resume.js";

export async function detectCase2Tasks(
  run: Run,
  runDir: string,
): Promise<string[]> {
  const matched: string[] = [];
  for (const task of run.tasks) {
    if (task.status !== "running") continue;
    const taskDir = join(runDir, "tasks", task.id);
    const outputPath = join(taskDir, "output.yaml");
    if (await pathExists(outputPath)) {
      matched.push(task.id);
    }
  }
  return matched;
}

export async function recoverCase2(
  run: Run,
  runDir: string,
  taskIds: readonly string[],
  hooks: ResumeFsHooks,
): Promise<Run> {
  let next = run;
  for (const taskId of taskIds) {
    const task = requireTask(next, taskId);
    const taskDir = join(runDir, "tasks", task.id);
    const agentCtxPath = join(taskDir, "agent-ctx");
    const outputPath = join(taskDir, "output.yaml");
    await hooks.runRemove(agentCtxPath);
    await hooks.runRemove(outputPath);
    next = withTask(next, task.id, (t) => ({
      ...t,
      status: "pending" as Task["status"],
    }));
  }
  return next;
}

function requireTask(run: Run, taskId: string): Task {
  const task = run.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    throw new Error(`resume case-2: task "${taskId}" missing from run "${run.name}"`);
  }
  return task;
}
