// Orchestrator Phase 1 — plan.
//
// `plan` is the second stage of a dispatch run, called after `initRun`. It:
//   1. Loads the target repo's skill files via `loadSkillFiles`.
//   2. Spawns the planner agent with the dispatch config's
//      `modelConfig.planner` model and provider creds.
//   3. Awaits the validated `FinalizedPlan` from the planner's
//      `finalizePlan` terminal tool.
//   4. Materializes the proposals into the run's `tasks: Task[]` array,
//      computing a canonical task id of the form `<level><sequence>-<slug>`
//      (the planner emits an unprefixed `idHint`-derived id; the
//      orchestrator owns the level/sequence prefix).
//   5. Writes each task's `plan.md` file from the proposal's
//      `planMarkdown` field, verbatim — the planner owns the body, this
//      module owns the file write.
//   6. Transitions the run status to `executing` and persists.
//
// Plan critique (Phase 2.5) is not implemented in the PoC; the
// orchestrator transitions directly from `planning` to `executing`. The
// `gating-plan` status remains in the runtime enum so plan critique can
// be added without a state-model change.
//
// Notes on the `plan(run)` signature: the task plan calls for
// `plan(run: Run): Promise<Run>`. The planner agent requires a model, a
// baseURL, an apiKey, and a contextDir (per `@intx/agent`'s one-agent-
// per-context-directory rule). Those are operator-supplied, not part of
// the persisted run state, so this module accepts a second `options`
// parameter carrying them. The function still consumes a `Run` and
// returns the updated `Run`; the operator is responsible for plumbing
// the runtime knobs through.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Dependencies } from "@intx/inference";

import {
  buildPlannerSeedMessage,
  createPlannerAgent,
  type FinalizedPlan,
  type ProposedTaskRecord,
} from "../agents/planner.js";
import { loadSkillFiles } from "../skill-loader.js";
import { writeRun, type Run, type Task } from "../state/index.js";

import type { DispatchConfig } from "./config.js";

export interface PlanOptions {
  readonly config: DispatchConfig;
  readonly baseURL: string;
  readonly apiKey: string;
  /** Inference adapter (e.g. "openai", "anthropic"). Required. */
  readonly adapter: string;
  /**
   * Where this run's per-task agent-context directories live. Each task
   * gets `<contextDirRoot>/<taskId>/agent-ctx/`; the planner itself runs
   * in `<contextDirRoot>/_planner/`.
   */
  readonly contextDirRoot: string;
  /**
   * Where to write each task's `plan.md`. Default:
   * `<targetRepoPath>/dispatch/<runName>/<taskId>/plan.md`.
   */
  readonly taskDirRoot?: string;
  /**
   * Where to persist the updated `Run`. Default:
   * `<targetRepoPath>/dispatch/<runName>/run-state.yaml`.
   */
  readonly runStatePath?: string;
  /**
   * Test seam. When provided, this function is used instead of
   * `createPlannerAgent` to produce the `FinalizedPlan`. Production
   * callers should leave this unset.
   */
  readonly plannerOverride?: (args: PlannerOverrideArgs) => Promise<FinalizedPlan>;
  /**
   * Inference-layer `Dependencies` forwarded to `createPlannerAgent` →
   * `createAgent`. Tests pass `setupHarness().deps` from
   * `@intx/inference-testing` so the planner's model calls route through
   * the deterministic harness instead of `globalThis.fetch`. Production
   * callers omit this.
   */
  readonly deps?: Dependencies;
}

export interface PlannerOverrideArgs {
  readonly specPath: string;
  readonly specText: string;
  readonly targetRepoPath: string;
  readonly seedMessage: string;
}

/**
 * Run the planner against `run.specPath`, materialize the resulting plan
 * into `run.tasks`, write each task's `plan.md`, and persist the updated
 * run state. Returns the updated `Run`.
 */
export async function plan(run: Run, options: PlanOptions): Promise<Run> {
  const targetRepoPath = resolve(run.targetRepoPath);
  const runDirDefault = join(targetRepoPath, "dispatch", run.name);
  const taskDirRoot = options.taskDirRoot ?? runDirDefault;
  const runStatePath = options.runStatePath ?? join(runDirDefault, "run-state.yaml");

  // The skill loader is strict about a missing `skills/` directory so
  // a misconfigured interchange-like target fails loudly. Plain demo
  // targets won't have skills at all; in that case we degrade
  // gracefully to an empty blob (the planner just gets less context).
  let skillBlob: Awaited<ReturnType<typeof loadSkillFiles>>;
  try {
    skillBlob = await loadSkillFiles(targetRepoPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Required skills directory not found")) {
      skillBlob = {
        blob: "",
        files: [],
        totalBytes: 0,
        missingOptional: [],
      };
    } else {
      throw err;
    }
  }
  const specAbsolute = resolve(run.specPath);
  const specText = await readFile(specAbsolute, "utf8");

  const seedMessage = buildPlannerSeedMessage({
    specText,
    specPath: run.specPath,
    skillBlob,
  });

  let finalized: FinalizedPlan;
  if (options.plannerOverride) {
    finalized = await options.plannerOverride({
      specPath: run.specPath,
      specText,
      targetRepoPath,
      seedMessage,
    });
  } else {
    finalized = await runPlannerAgent({
      specPath: run.specPath,
      skillBlob,
      targetRepoPath,
      contextDir: join(options.contextDirRoot, "_planner"),
      model: options.config.modelConfig.planner,
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      adapter: options.adapter,
      seedMessage,
      ...(options.deps !== undefined ? { deps: options.deps } : {}),
    });
  }

  const tasks = materializeTasks(finalized);

  await mkdir(taskDirRoot, { recursive: true });
  for (const task of tasks) {
    const taskDir = join(taskDirRoot, task.id);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "plan.md"), task.planMarkdown, "utf8");
  }

  const updated: Run = {
    ...run,
    tasks,
    status: "executing",
  };

  await writeRun(runStatePath, updated);
  return updated;
}

interface RunPlannerArgs {
  readonly specPath: string;
  readonly skillBlob: Awaited<ReturnType<typeof loadSkillFiles>>;
  readonly targetRepoPath: string;
  readonly contextDir: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly adapter: string;
  readonly seedMessage: string;
  readonly deps?: Dependencies;
}

async function runPlannerAgent(args: RunPlannerArgs): Promise<FinalizedPlan> {
  const { agent, awaitFinalizedPlan } = await createPlannerAgent({
    specPath: args.specPath,
    skillBlob: args.skillBlob,
    targetRepoPath: args.targetRepoPath,
    contextDir: args.contextDir,
    model: args.model,
    baseURL: args.baseURL,
    apiKey: args.apiKey,
    adapter: args.adapter,
    seedMessage: args.seedMessage,
    ...(args.deps !== undefined ? { deps: args.deps } : {}),
  });

  // Drain the agent's event stream concurrently with `send` so any
  // inference.error / tool.* event the reactor emits surfaces to the
  // orchestrator's stderr — without this, a 4xx from the provider
  // silently drops the reactor on the floor.
  const drain = (async () => {
    try {
      for await (const event of agent.stream()) {
        if (event.type === "inference.error") {
          // eslint-disable-next-line no-console
          console.error(
            `[planner] inference.error: ${JSON.stringify(event.data?.error ?? event.data)}`,
          );
        }
      }
    } catch {
      // The stream ends with an error when the agent closes; that is
      // not a failure mode we need to surface from the drain itself.
    }
  })();

  try {
    // Race agent.send (which drives the reactor; resolves when the
    // reactor stops emitting events — including on inference errors)
    // against awaitFinalizedPlan (which resolves only when the planner
    // explicitly calls the terminal tool). If `send` finishes first
    // the agent died before finalizing — surface that as a loud error
    // instead of hanging on a Promise that will never resolve.
    const sendDone = agent.send(args.seedMessage).then(() => "send-done" as const);
    const finalize = awaitFinalizedPlan.then((value) => ({
      kind: "finalize" as const,
      value,
    }));
    const winner = await Promise.race([sendDone, finalize]);
    if (winner === "send-done") {
      throw new Error(
        `planner agent closed without calling finalizePlan — most likely an inference-provider error. Inspect the agent context's turns.jsonl at ${args.contextDir} for diagnostics.`,
      );
    }
    return winner.value;
  } finally {
    await agent.close();
    await drain;
  }
}

/**
 * Turn the planner's level-tagged proposals into `Task[]` records ready
 * to persist. The planner emits an `id` derived from `idHint` (e.g.
 * `state-model`); we prefix it with `<level><sequence>-` so the on-disk
 * task directories sort cleanly and match the spec's convention
 * (`2a-state-model`, `2b-skill-loader`, etc.).
 *
 * Sequence letters are assigned per level in proposal order: the first
 * proposal at level N becomes `a`, the second `b`, and so on. Beyond `z`
 * we wrap to `aa`, `ab`, ... — but a level with more than 26 tasks is a
 * planning smell, not a feature we expect to hit.
 */
function materializeTasks(finalized: FinalizedPlan): Task[] {
  const byLevel = new Map<number, ProposedTaskRecord[]>();
  for (const proposal of finalized.tasks) {
    const bucket = byLevel.get(proposal.level);
    if (bucket) {
      bucket.push(proposal);
    } else {
      byLevel.set(proposal.level, [proposal]);
    }
  }

  const idRemap = new Map<string, string>();
  const tasks: Task[] = [];

  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const level of sortedLevels) {
    const bucket = byLevel.get(level);
    if (!bucket) continue;
    bucket.forEach((proposal, index) => {
      const sequence = sequenceLetter(index);
      const taskId = `${String(level)}${sequence}-${proposal.id}`;
      idRemap.set(proposal.id, taskId);
    });
  }

  for (const level of sortedLevels) {
    const bucket = byLevel.get(level);
    if (!bucket) continue;
    bucket.forEach((proposal, index) => {
      const sequence = sequenceLetter(index);
      const id = idRemap.get(proposal.id);
      if (id === undefined) {
        throw new Error(`internal error: no remap entry for proposal id "${proposal.id}"`);
      }
      const dependsOn = proposal.dependsOn.map((dep) => {
        const remapped = idRemap.get(dep);
        if (remapped === undefined) {
          throw new Error(
            `internal error: dependsOn "${dep}" of proposal "${proposal.id}" was not in the finalized plan`,
          );
        }
        return remapped;
      });

      tasks.push({
        id,
        level: proposal.level,
        sequence,
        dependsOn,
        objective: proposal.objective,
        planMarkdown: proposal.planMarkdown,
        agentType: proposal.agentType,
        class: proposal.class,
        critiqueEnabled: proposal.critiqueEnabled,
        verifyCommands: [...proposal.verifyCommands],
        status: "pending",
        fixingSource: null,
        worktreePath: null,
        output: null,
        commitSHA: null,
        critiqueVerdicts: [],
        amendmentRoundsTotal: 0,
        verificationFixRoundsTotal: 0,
      });
    });
  }

  return tasks;
}

function sequenceLetter(index: number): string {
  if (index < 0) {
    throw new Error(`sequenceLetter called with negative index ${String(index)}`);
  }
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
