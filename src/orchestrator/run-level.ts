// `runLevel` — orchestrate one level of a run.
//
// Step-by-step (per spec §346-§352, §369-§385, §461-§472):
//
//   1. Provision (or reuse) the level's git worktree and verify it is clean.
//      `provisionLevelWorktree` does both; a failed clean-check aborts the
//      level before any implementer runs.
//   2. Update each task in the level with the resolved `worktreePath` and
//      transition it to `running`. The persisted-run document is rewritten
//      at this point so a crash leaves the disk consistent with reality.
//   3. Fan implementers out in parallel (bounded by `maxParallel`). Each
//      implementer gets its own `agent-ctx/` directory; all share the same
//      worktree filesystem (no per-task git worktree).
//   4. As each implementer's `submitOutput` resolves, persist the submitted
//      output onto the task record (`task.output`), write the task's
//      `output.yaml` to disk for the greybeard's read-allowlist, then run
//      Karen's per-task loop against the deviations.
//   5. If Karen aborts the run, surface immediately — the level is dead.
//      If Karen fails a task, mark it `failed` and exclude it from fan-in.
//   6. After every implementer's loop has resolved, run the unreported-
//      modifications check against the union of successful tasks'
//      `filesModified`. Unclaimed modifications are a fatal failure.
//   7. Return the updated run-state document.
//
// `runLevel` does NOT commit; `commitLevel` (5c) owns commits.
//
// Concurrency caps:
//
//   The fan-out concurrency is bounded by `maxParallel`. The orchestrator
//   provides the value; we default it to `tasks.length` (no cap) when the
//   caller does not pass one. Per-task Karen loops are serialized within a
//   task (one deviation at a time) but run in parallel across tasks — the
//   `Promise.all` of `dispatchTask` handles that automatically because each
//   call invokes `runKarenLoopForTask` synchronously after its
//   `awaitSubmitOutput` resolves.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify as stringifyYAML } from "yaml";

import { AgentClosedError } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { ReactorDirector } from "@intx/types/runtime";

import { writeRun } from "../state/persist.js";
import type {
  Deviation,
  Run,
  Task,
  TaskOutput,
} from "../state/types.js";
import {
  createImplementerAgent,
  type CreateImplementerAgentOptions,
  type SubmittedDeviation,
  type SubmittedOutput,
} from "../agents/implementer.js";
import {
  provisionLevelWorktree,
  type ProvisionLevelWorktreeOptions,
} from "./worktree.js";
import {
  runKarenLoopForTask,
  type GreybeardSpawner,
  type KarenLoopResult,
  type OperatorResolver,
} from "./karen-loop.js";
import {
  checkUnreportedModifications,
  type GitStatusExecutor,
} from "./unreported-mods.js";

export interface ImplementerSpawnInput {
  task: Task;
  worktreePath: string;
  contextDir: string;
  model: string;
  baseURL: string;
  apiKey: string;
  /**
   * Inference adapter name (e.g. "openai" for opencode-go's
   * OpenAI-compatible endpoint, "anthropic" for Anthropic's API).
   * Forwarded to `createImplementerAgent` so the underlying
   * `ProviderConfig.provider` reaches the inference harness.
   * Optional in the type only because test seams supply a director
   * and never reach the inference layer; production callers must
   * thread it through.
   */
  adapter?: string;
  director?: ReactorDirector;
}

/**
 * Minimal agent surface the run-level loop needs from an implementer handle.
 * Production code (`createImplementerAgent`) returns a full `Agent`, which
 * satisfies this structurally; tests provide a stub with just `send` and
 * `close`. Mirrors the `GreybeardAgentHandle` pattern in `karen-loop.ts`.
 */
export interface ImplementerAgentHandle {
  send(content: string): Promise<unknown>;
  close(): Promise<void>;
  /**
   * Event stream exposed by `@intx/agent`'s `Agent`. The orchestrator
   * drains it concurrently with `send` so provider-side errors
   * (inference.error) surface to stderr instead of vanishing into a
   * silently-closed reactor.
   */
  stream(): AsyncIterable<ReactorEmittedEvent>;
}

export type ImplementerSpawner = (
  input: ImplementerSpawnInput,
) => Promise<{
  agent: ImplementerAgentHandle;
  awaitSubmitOutput: Promise<SubmittedOutput>;
}>;

export interface DirectorFactoryInput {
  task: Task;
}

/**
 * Closure that constructs a `ReactorDirector` for a specific task. The
 * production code path leaves this undefined and the implementer agent talks
 * to a real provider over HTTP. Tests pass a factory that returns a scripted
 * director per task id.
 */
export type DirectorFactory = (input: DirectorFactoryInput) => ReactorDirector;

export interface RunLevelOptions {
  /** Run document. The function returns a new document; the input is not mutated. */
  run: Run;
  /** Level number to execute. */
  level: number;
  /** Absolute path to the target repository. */
  repoRoot: string;
  /** Absolute path to the run directory (`<repoRoot>/dispatch/<runName>`). */
  runDir: string;
  /** Absolute path to the run-state YAML for atomic re-persistence. */
  runStatePath: string;
  /** Provider model identifier (implementer + greybeard agents). */
  model: string;
  /** Provider base URL. */
  baseURL: string;
  /** Provider API key. */
  apiKey: string;
  /**
   * Inference adapter name forwarded to every agent spawned within
   * this level (implementer + greybeard). Optional only because
   * tests wire scripted directors that bypass the inference layer;
   * production callers must thread it through.
   */
  adapter?: string;
  /**
   * Maximum parallel implementer agents. Defaults to the number of tasks in
   * the level (no cap). The orchestrator typically reads this from
   * `dispatch-config.yaml` via `Run.modelConfig` (when 5a finalizes that
   * shape) and threads it through.
   */
  maxParallel?: number;
  /**
   * Per-task scripted-director factory. When provided, the spawner builds
   * the implementer with the returned director instead of the production
   * default. Tests pass this to bypass HTTP.
   */
  directorFactory?: DirectorFactory;
  /**
   * Per-task greybeard scripted-director factory. Forwarded into the
   * Karen-loop spawner.
   */
  greybeardDirectorFactory?: DirectorFactory;
  /** Injectable implementer spawner; defaults to `createImplementerAgent`. */
  implementerSpawner?: ImplementerSpawner;
  /** Injectable greybeard spawner; defaults to `createGreybeardAgent`. */
  greybeardSpawner?: GreybeardSpawner;
  /** Injectable operator resolver; defaults to `awaitOperatorResolution`. */
  operatorResolver?: OperatorResolver;
  /** Injectable git executor; forwarded into worktree provisioning. */
  gitExecutor?: ProvisionLevelWorktreeOptions["gitExecutor"];
  /** Injectable git-status executor for the unreported-modifications check. */
  gitStatusExecutor?: GitStatusExecutor;
  /** Forwarded poll interval for the default operator resolver. */
  operatorPollIntervalMs?: number;
  /** Forwarded timeout for the default operator resolver. */
  operatorTimeoutMs?: number;
}

export interface RunLevelResult {
  run: Run;
  /** Per-task Karen loop results, keyed by task id for diagnostics. */
  karenResults: Record<string, KarenLoopResult>;
  /** Absolute path to the level worktree (provisioned or reused). */
  worktreePath: string;
}

export class UnreportedModificationsError extends Error {
  override name = "UnreportedModificationsError";
  constructor(
    public readonly worktreePath: string,
    public readonly unclaimed: string[],
  ) {
    super(
      `unreported modifications in ${worktreePath}: ${unclaimed.join(", ")}`,
    );
  }
}

export class RunAbortedByOperatorError extends Error {
  override name = "RunAbortedByOperatorError";
  constructor(
    public readonly taskId: string,
    public readonly deviationId: string,
  ) {
    super(
      `run aborted by operator while evaluating deviation ${deviationId} on task ${taskId}`,
    );
  }
}

/**
 * Execute one level of the run. See file header for the step-by-step.
 *
 * The function rewrites `Run` immutably: the returned `run` is a new
 * document containing the updated task statuses, outputs, and (post-fan-in)
 * the level's working-tree state. The caller is responsible for persisting
 * the result to disk; this function also re-persists at each significant
 * transition so a crash mid-level leaves a recoverable on-disk state.
 */
export async function runLevel(options: RunLevelOptions): Promise<RunLevelResult> {
  const levelTasks = options.run.tasks.filter((t) => t.level === options.level);
  if (levelTasks.length === 0) {
    throw new Error(
      `runLevel: no tasks at level ${String(options.level)} in run ${options.run.name}`,
    );
  }

  const provisionOptions: ProvisionLevelWorktreeOptions = {
    run: options.run,
    level: options.level,
    repoRoot: options.repoRoot,
    runDir: options.runDir,
    ...(options.gitExecutor !== undefined
      ? { gitExecutor: options.gitExecutor }
      : {}),
  };
  const provision = await provisionLevelWorktree(provisionOptions);
  const worktreePath = provision.worktreePath;

  let working: Run = updateLevelTasks(options.run, options.level, (task) => ({
    ...task,
    worktreePath,
    status: "running",
  }));
  await writeRun(options.runStatePath, working);

  const taskDirsByTaskId = new Map<string, TaskRuntimePaths>();
  for (const task of levelTasks) {
    const taskDir = join(options.runDir, "tasks", task.id);
    const planPath = join(taskDir, "plan.md");
    const outputPath = join(taskDir, "output.yaml");
    const contextDir = join(taskDir, "agent-ctx");
    const greybeardContextRoot = join(taskDir, "greybeard");
    await mkdir(contextDir, { recursive: true });
    await mkdir(greybeardContextRoot, { recursive: true });
    // The implementer agent writes plan.md elsewhere (the planner owns it);
    // here we ensure the directory exists so the greybeard's read-allowlist
    // works even if the planner has not yet materialized the file.
    await writeFile(planPath, task.planMarkdown, { flag: "wx" }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") return;
        throw err;
      },
    );
    taskDirsByTaskId.set(task.id, {
      taskDir,
      planPath,
      outputPath,
      contextDir,
      greybeardContextRoot,
    });
  }

  const maxParallel = options.maxParallel ?? levelTasks.length;
  const dispatchOutcomes = await runWithConcurrency(
    levelTasks,
    maxParallel,
    async (task) => {
      const paths = taskDirsByTaskId.get(task.id);
      if (paths === undefined) {
        throw new Error(`runLevel: no runtime paths registered for task ${task.id}`);
      }
      return dispatchOneTask({
        task,
        paths,
        worktreePath,
        options,
      });
    },
  );

  const karenResults: Record<string, KarenLoopResult> = {};
  for (const outcome of dispatchOutcomes) {
    karenResults[outcome.taskId] = outcome.karenResult;
  }

  for (const outcome of dispatchOutcomes) {
    if (outcome.karenResult.finalState.kind === "aborted") {
      throw new RunAbortedByOperatorError(
        outcome.taskId,
        outcome.karenResult.finalState.deviation.id,
      );
    }
  }

  working = applyOutcomes(working, options.level, dispatchOutcomes);
  await writeRun(options.runStatePath, working);

  const claimedFiles = collectClaimedFiles(dispatchOutcomes);
  const modCheck = await checkUnreportedModifications({
    worktreePath,
    claimedFiles,
    ...(options.gitStatusExecutor !== undefined
      ? { gitStatusExecutor: options.gitStatusExecutor }
      : {}),
  });
  if (!modCheck.ok) {
    throw new UnreportedModificationsError(worktreePath, modCheck.unclaimed);
  }

  return { run: working, karenResults, worktreePath };
}

interface TaskRuntimePaths {
  taskDir: string;
  planPath: string;
  outputPath: string;
  contextDir: string;
  greybeardContextRoot: string;
}

interface TaskDispatchOutcome {
  taskId: string;
  submitted: SubmittedOutput | null;
  karenResult: KarenLoopResult;
}

async function dispatchOneTask(args: {
  task: Task;
  paths: TaskRuntimePaths;
  worktreePath: string;
  options: RunLevelOptions;
}): Promise<TaskDispatchOutcome> {
  const { task, paths, worktreePath, options } = args;
  const spawner = options.implementerSpawner ?? defaultImplementerSpawner;

  const director = options.directorFactory?.({ task });
  const spawnInput: ImplementerSpawnInput = {
    task,
    worktreePath,
    contextDir: paths.contextDir,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
    ...(director !== undefined ? { director } : {}),
  };
  const handle = await spawner(spawnInput);

  // Drain the implementer agent's event stream so any inference.error
  // surfaces to stderr — without this, a 4xx from the provider drops
  // the reactor silently and the orchestrator only sees the terse
  // AgentClosedError.
  const drain = (async () => {
    try {
      for await (const event of handle.agent.stream()) {
        if (event.type === "inference.error") {
          // eslint-disable-next-line no-console
          console.error(
            `[implementer ${task.id}] inference.error: ${JSON.stringify(event.data?.error ?? event.data)}`,
          );
        }
      }
    } catch {
      // The stream throws on agent close; not a failure to surface.
    }
  })();

  let submitted: SubmittedOutput | null = null;
  try {
    // Race the implementer's `awaitSubmitOutput` against the lifecycle
    // promise of `agent.send`. The default director path returns a
    // `send` promise that resolves on reply or rejects with
    // `AgentClosedError` if the reactor terminates without one. By racing
    // the two we both await the terminal tool's normal resolution and
    // surface a never-submitted agent as a loud `AgentClosedError` rather
    // than hanging forever.
    const sendPromise = handle.agent.send(buildImplementerSeed(task));
    submitted = await Promise.race([
      handle.awaitSubmitOutput,
      sendPromise.then(() => {
        throw new AgentClosedError();
      }),
    ]);
    sendPromise.catch((err: unknown) => {
      if (err instanceof AgentClosedError) return;
      throw err;
    });
  } finally {
    await handle.agent.close();
    await drain;
  }

  await writeFile(
    paths.outputPath,
    stringifyYAML(submitted),
    "utf8",
  );

  const deviations = submitted.deviations.map(
    (d, idx): Deviation => promoteDeviation(d, task.id, idx),
  );
  const greybeardDirector = options.greybeardDirectorFactory?.({ task });
  const karenResult = await runKarenLoopForTask({
    task,
    deviations,
    runDir: options.runDir,
    planPath: paths.planPath,
    outputPath: paths.outputPath,
    worktreePath,
    greybeardContextRoot: paths.greybeardContextRoot,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    adapter: options.adapter ?? "anthropic",
    ...(greybeardDirector !== undefined
      ? { greybeardDirector }
      : {}),
    ...(options.greybeardSpawner !== undefined
      ? { greybeardSpawner: options.greybeardSpawner }
      : {}),
    ...(options.operatorResolver !== undefined
      ? { operatorResolver: options.operatorResolver }
      : {}),
    ...(options.operatorPollIntervalMs !== undefined
      ? { operatorPollIntervalMs: options.operatorPollIntervalMs }
      : {}),
    ...(options.operatorTimeoutMs !== undefined
      ? { operatorTimeoutMs: options.operatorTimeoutMs }
      : {}),
  });

  return { taskId: task.id, submitted, karenResult };
}

function buildImplementerSeed(task: Task): string {
  const lines: string[] = [];
  lines.push(`# Implementer task: ${task.id}`);
  lines.push("");
  lines.push(`Objective: ${task.objective}`);
  lines.push("");
  lines.push("Make the changes described in your task plan inside the assigned worktree. Use `recordBuildResult` to log every build/lint/test command you run. Call `submitOutput` exactly once when finished.");
  return lines.join("\n");
}

function promoteDeviation(
  submitted: SubmittedDeviation,
  taskId: string,
  index: number,
): Deviation {
  return {
    id: `${taskId}-dev-${String(index + 1)}`,
    severity: submitted.severity,
    category: submitted.category,
    description: submitted.description,
    affectedFiles: submitted.affectedFiles,
  };
}

function updateLevelTasks(
  run: Run,
  level: number,
  fn: (task: Task) => Task,
): Run {
  return {
    ...run,
    tasks: run.tasks.map((t) => (t.level === level ? fn(t) : t)),
  };
}

function applyOutcomes(
  run: Run,
  level: number,
  outcomes: readonly TaskDispatchOutcome[],
): Run {
  const byId = new Map(outcomes.map((o) => [o.taskId, o]));
  return updateLevelTasks(run, level, (task) => {
    const outcome = byId.get(task.id);
    if (outcome === undefined) return task;
    const submitted = outcome.submitted;
    if (submitted === null) return { ...task, status: "failed" };
    const promotedDeviations = submitted.deviations.map(
      (d, idx): Deviation => promoteDeviation(d, task.id, idx),
    );
    const taskOutput: TaskOutput = {
      summary: submitted.summary,
      filesModified: submitted.filesModified,
      deviations: promotedDeviations,
      notes: submitted.notes,
    };
    const finalState = outcome.karenResult.finalState;
    const nextStatus = finalState.kind === "failed" ? "failed" : "submitted";
    return { ...task, output: taskOutput, status: nextStatus };
  });
}

function collectClaimedFiles(
  outcomes: readonly TaskDispatchOutcome[],
): string[] {
  const claimed = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.karenResult.finalState.kind !== "accepted") continue;
    if (outcome.submitted === null) continue;
    for (const f of outcome.submitted.filesModified) claimed.add(f);
  }
  return Array.from(claimed);
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          const item = items[index];
          if (item === undefined) return;
          results[index] = await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

const defaultImplementerSpawner: ImplementerSpawner = async (input) => {
  if (input.adapter === undefined) {
    throw new Error(
      "defaultImplementerSpawner: adapter is required (e.g. \"openai\" for opencode-go-style endpoints). Wire it through RunLevelOptions.adapter.",
    );
  }
  const spawnOptions: CreateImplementerAgentOptions = {
    worktreePath: input.worktreePath,
    contextDir: input.contextDir,
    model: input.model,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    adapter: input.adapter,
    ...(input.director !== undefined ? { director: input.director } : {}),
  };
  const impl = await createImplementerAgent(spawnOptions);
  return { agent: impl.agent, awaitSubmitOutput: impl.awaitSubmitOutput };
};
