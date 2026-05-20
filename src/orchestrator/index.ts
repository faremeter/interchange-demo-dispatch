// Public orchestrator barrel + `runDispatch` integration loop.
//
// `runDispatch(spec, options?)` is the single entry point for a
// dispatch run. It wires every upstream piece (5a init / plan, 5b
// runLevel, 5c commitLevel, 5d gate, 6a verifyAgainstBaseline) into a
// linear forward path, persists state after every meaningful
// transition, and writes the human-readable final report at the end.
//
// Locked policies (spec.md §432-§453, §716-§744):
//
//   - `commitStrategy` is locked to "per-task" for the PoC. If a
//     dispatch-config.yaml ever declares a different value, the
//     orchestrator fails loudly at load.
//   - Amendment cap (3 notify / 4 escalate) and critique enablement
//     are enforced inside the gate / amendment-loop modules; the
//     orchestrator's role is to wire `awaitOperatorResolution` and
//     the notify sink so those layers can act.
//   - Worktrees survive a successful run — there is no automatic
//     teardown. The CLI's `teardown` verb is the operator-initiated
//     cleanup.
//
// Resume hook: when `<runDir>/run-state.yaml` already exists at
// invocation time, the loop calls `options.resume(runDir)` to recover
// state. The default resume callback is a no-op that loads the file
// and returns it as-is — `7b-resume` will replace it with a real
// recovery implementation by extending the same `Run`-shaped
// contract.
//
// Test seams: every external collaborator (planner, implementer
// directors, critic, gate critic, fix agent, attribution agent, build
// gate, per-task verifier, operator resolver, greybeard) is
// injectable. The CLI omits every override and the orchestrator wires
// the production factories; tests pass scripted runners to exercise
// the forward path without HTTP.

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parse as parseYAML } from "yaml";

import { createCriticAgent } from "../agents/critic.js";
import {
  createGateCriticAgent,
  type PerTaskGateCriticInput,
} from "../agents/gate-critic.js";
import { createImplementerAgent } from "../agents/implementer.js";
import { loadRun, writeRun } from "../state/index.js";
import type { Finding, Run, Task } from "../state/index.js";

import { initRun, type InitRunResult, type SpecRef } from "./init.js";
import { plan, type PlanOptions, type PlannerOverrideArgs } from "./plan.js";
import { loadDispatchConfig } from "./config.js";
import { buildFixAgentSeed } from "./fix-agent.js";
import {
  runLevel,
  type DirectorFactory,
  type RunLevelOptions,
} from "./run-level.js";
import { commitLevel } from "./commit-level.js";
import {
  gate,
  type CriticRunner,
  type FixAgentRunner,
  type GateCriticRunner,
  type OperatorResolutionCallback,
  type RebuildCallback,
} from "./gate.js";
import {
  buildAttributionSeed,
  createAttributionAgent,
  verifyAgainstBaseline,
  type AttributionAgentRunner,
  type BuildGateRunner,
  type GateCallback,
  type Phase5FixAgentRunner,
  type TaskVerifier,
  type VerifyAgainstBaselineOptions,
} from "./phase5/index.js";
import {
  createDefaultBuildGateRunner,
  createDefaultTaskVerifier,
} from "./shell.js";
import { awaitOperatorResolution } from "./operator-escalation.js";
import { levelsOf } from "./level-iterator.js";
import { writeFinalReport } from "./final-report.js";
import type { GreybeardSpawner, OperatorResolver } from "./karen-loop.js";

export interface ProviderCredentials {
  readonly baseURL: string;
  readonly apiKey: string;
  /**
   * Inference adapter that selects the HTTP API style — e.g.
   * "openai" for OpenAI-compatible endpoints (including opencode-go)
   * or "anthropic" for the Anthropic API. Threaded through to every
   * spawned agent so the inference harness picks the matching
   * adapter. Required: no sensible default exists across providers.
   */
  readonly adapter: string;
}

/**
 * Inference-layer Dependencies (`fetch`, clock, etc.) threaded down
 * to every spawned agent. Production callers leave this undefined and
 * `@intx/agent` falls back to `createDefaultDependencies()` bound to
 * `globalThis.fetch`. Tests pass `setupHarness().deps` from
 * `@intx/inference-testing` so every model call is intercepted by the
 * deterministic harness — that is the only supported mock seam.
 */
import type { Dependencies } from "@intx/inference";
export type { Dependencies };

export interface RunDispatchOptions {
  /**
   * Provider credentials for any real-agent invocations. Required when
   * production overrides are not supplied; tests may omit it because
   * the scripted overrides never reach the model.
   */
  readonly provider?: ProviderCredentials;
  /**
   * Hook called when `<runDir>/run-state.yaml` already exists at
   * invocation time. The default loads the persisted document and
   * returns it untouched (a stub `7b-resume` will replace). Returning
   * a `Run` whose status is `done` causes `runDispatch` to short-
   * circuit immediately.
   */
  readonly resume?: (runDir: string) => Promise<Run>;
  /**
   * Inference-layer `Dependencies` (fetch stub, clock, etc.). When
   * present, every agent spawned by the orchestrator threads this
   * through to `createAgent`'s `deps` parameter, so model calls go
   * through the same fetch instance. Tests pass
   * `setupHarness().deps` from `@intx/inference-testing` to intercept
   * model calls deterministically. Omit for production runs and the
   * agent factory falls back to `globalThis.fetch`.
   */
  readonly deps?: Dependencies;
  /**
   * Scripted planner override forwarded to `plan(...)`. When set,
   * `plan` never spawns the planner agent.
   */
  readonly plannerOverride?: (args: PlannerOverrideArgs) => ReturnType<NonNullable<PlanOptions["plannerOverride"]>>;
  /** Scripted implementer director factory forwarded to `runLevel(...)`. */
  readonly directorFactory?: DirectorFactory;
  /** Scripted greybeard director factory forwarded to `runLevel(...)`. */
  readonly greybeardDirectorFactory?: DirectorFactory;
  /** Scripted greybeard spawner forwarded to `runLevel(...)`. */
  readonly greybeardSpawner?: GreybeardSpawner;
  /**
   * Operator resolver used both by `runLevel` (file-watch escape
   * hatch via Karen) and by the gate / verify pipelines.
   * Production callers leave this unset and the orchestrator wires
   * `awaitOperatorResolution` against `<runDir>`.
   */
  readonly operatorResolver?: OperatorResolver;
  /** Scripted critic runner used by `gate(...)`. */
  readonly criticRunner?: CriticRunner;
  /** Scripted gate-critic runner used by `gate(...)`. */
  readonly gateCriticRunner?: GateCriticRunner;
  /** Scripted amendment-loop fix agent runner used by `gate(...)`. */
  readonly fixAgentRunner?: FixAgentRunner;
  /** Scripted Phase-5 fix agent runner used by `verifyAgainstBaseline(...)`. */
  readonly phase5FixAgentRunner?: Phase5FixAgentRunner;
  /** Scripted attribution agent runner used by `verifyAgainstBaseline(...)`. */
  readonly attributionRunner?: AttributionAgentRunner;
  /** Scripted build-gate runner used by `verifyAgainstBaseline(...)`. */
  readonly buildGateRunner?: BuildGateRunner;
  /** Scripted per-task verifier used by `verifyAgainstBaseline(...)`. */
  readonly taskVerifier?: TaskVerifier;
  /**
   * Optional cap on Phase-5 outer fix-loop iterations. Forwarded
   * verbatim to `verifyAgainstBaseline(...)`; the engine falls back
   * to its own default when undefined.
   */
  readonly verifyMaxLoops?: number;
  /**
   * Optional sink for informational notices (round-3 amendment /
   * fix-phase notify, etc.). Defaults to a no-op so the CLI does not
   * spam stdout outside the report path.
   */
  readonly notify?: (message: string) => void;
  /**
   * Test seam: override "now" for the final report timestamp. The
   * forward path itself reads only `Date.now()`-derived values from
   * upstream layers, which are not affected by this override.
   */
  readonly now?: Date;
}

/**
 * Drive a dispatch run end-to-end. See file header for the locked
 * policies and the resume contract. The returned `Run` is the final
 * persisted document; `<runDir>/report.md` contains the human-readable
 * summary.
 */
export async function runDispatch(
  spec: SpecRef,
  options: RunDispatchOptions = {},
): Promise<Run> {
  const targetRepoPath = resolve(spec.targetRepoPath);
  const runDir = join(targetRepoPath, "dispatch", spec.runName);
  const runStatePath = join(runDir, "run-state.yaml");

  await assertLockedCommitStrategy(spec.dispatchConfigPath);

  if (await pathExists(runStatePath)) {
    const resume = options.resume ?? defaultResume;
    const resumed = await resume(runDir);
    if (resumed.status === "done") return resumed;
    if (resumed.status === "failed") return resumed;

    // The resume hook has already normalized any inconsistent on-disk
    // state (stale agent-ctx, orphan logs, missing boundaries). What
    // remains is routing the normalized run back into the appropriate
    // stage of the forward path.
    return continueAfterResume({
      resumed,
      spec,
      runDir,
      runStatePath,
      targetRepoPath,
      options,
    });
  }

  const init = await initRun(spec);
  return continueAfterInit({
    init,
    runDir,
    runStatePath,
    targetRepoPath,
    options,
    specName: spec.runName,
  });
}

interface ContinueAfterInitArgs {
  readonly init: InitRunResult;
  readonly runDir: string;
  readonly runStatePath: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
  readonly specName: string;
}

/**
 * The portion of `runDispatch` after `initRun` has produced a fresh
 * `InitRunResult`. Extracted so the resume path can synthesize an
 * `InitRunResult` from a persisted Run and call here instead of
 * re-running `initRun` (which would fail because the dispatch
 * directory and integration branch already exist).
 */
async function continueAfterInit(args: ContinueAfterInitArgs): Promise<Run> {
  const { init, runDir, runStatePath, targetRepoPath, options, specName } = args;

  const planned = await runPlanStage({
    init,
    runDir,
    targetRepoPath,
    options,
  });

  return continueAfterPlan({
    planned,
    init,
    runDir,
    runStatePath,
    targetRepoPath,
    options,
    specName,
  });
}

interface ContinueAfterPlanArgs {
  readonly planned: Run;
  readonly init: InitRunResult;
  readonly runDir: string;
  readonly runStatePath: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
  readonly specName: string;
}

async function continueAfterPlan(args: ContinueAfterPlanArgs): Promise<Run> {
  const { planned, init, runDir, runStatePath, targetRepoPath, options, specName } = args;

  const levels = levelsOf(planned);
  if (levels.length === 0) {
    throw new Error(
      `runDispatch: planner produced no tasks for run "${specName}"`,
    );
  }

  let working: Run = planned;
  for (const level of levels) {
    working = await runOneLevel({
      run: working,
      level,
      init,
      runDir,
      runStatePath,
      targetRepoPath,
      options,
    });
    if (working.status === "failed") {
      working = await finalizeReport(working, runDir, runStatePath, options.now);
      return working;
    }
  }

  working = await runVerification({
    run: working,
    init,
    runDir,
    runStatePath,
    targetRepoPath,
    options,
  });

  if (working.status === "failed") {
    working = await finalizeReport(working, runDir, runStatePath, options.now);
    return working;
  }

  working = { ...working, status: "done" };
  await writeRun(runStatePath, working);
  working = await finalizeReport(working, runDir, runStatePath, options.now);
  return working;
}

interface ContinueAfterResumeArgs {
  readonly resumed: Run;
  readonly spec: SpecRef;
  readonly runDir: string;
  readonly runStatePath: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
}

/**
 * Route a resumed run into the appropriate forward-path stage based on
 * its persisted status. Terminal statuses (`done`, `failed`) are
 * handled by the caller before reaching here. For non-terminal
 * statuses, the resume hook is assumed to have normalized any
 * inconsistent on-disk state.
 *
 * - `planning` / `gating-plan`: `initRun` already ran; reconstruct a
 *   synthetic `InitRunResult` from the persisted run + reloaded
 *   config and re-enter at the plan stage.
 * - `executing` / `verifying` / `fixing-verification` / `consolidating`:
 *   not yet implemented in the PoC. Throws with a clear message and
 *   the workaround (manual cleanup).
 */
async function continueAfterResume(args: ContinueAfterResumeArgs): Promise<Run> {
  const { resumed, spec, runDir, runStatePath, targetRepoPath, options } = args;

  if (resumed.status === "planning" || resumed.status === "gating-plan") {
    const config = await loadDispatchConfig(spec.dispatchConfigPath);
    const init: InitRunResult = { run: resumed, config, runStatePath };
    return continueAfterInit({
      init,
      runDir,
      runStatePath,
      targetRepoPath,
      options,
      specName: spec.runName,
    });
  }

  throw new Error(
    `runDispatch: resume from status "${resumed.status}" is not yet implemented (PoC scope). Workaround: \`rm -rf ${runDir}\` and \`git branch -D ${resumed.integrationBranch}\` in ${targetRepoPath}, then re-run.`,
  );
}

const defaultResume: NonNullable<RunDispatchOptions["resume"]> = async (
  runDir: string,
) => {
  const statePath = join(runDir, "run-state.yaml");
  return loadRun(statePath);
};

interface RunStageInput {
  readonly init: InitRunResult;
  readonly runDir: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
}

async function runPlanStage(input: RunStageInput): Promise<Run> {
  const planOptions = buildPlanOptions(input);
  return plan(input.init.run, planOptions);
}

function buildPlanOptions(input: RunStageInput): PlanOptions {
  const { init, runDir, options } = input;
  const contextDirRoot = join(runDir, "agent-contexts");

  if (options.plannerOverride !== undefined) {
    return {
      config: init.config,
      baseURL: "test://unused",
      apiKey: "test-unused",
      adapter: "test-unused",
      contextDirRoot,
      plannerOverride: options.plannerOverride,
    };
  }

  const provider = requireProvider(options, "plan");
  return {
    config: init.config,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    adapter: provider.adapter,
    contextDirRoot,
  };
}

interface LevelStageInput {
  readonly run: Run;
  readonly level: number;
  readonly init: InitRunResult;
  readonly runDir: string;
  readonly runStatePath: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
}

async function runOneLevel(input: LevelStageInput): Promise<Run> {
  const { run, level, init, runDir, runStatePath, targetRepoPath, options } = input;
  const provider = requireProvider(options, "level");
  const runLevelOptions: RunLevelOptions = {
    run,
    level,
    repoRoot: targetRepoPath,
    runDir,
    runStatePath,
    model: init.config.modelConfig.implementer,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    adapter: provider.adapter,
    ...(options.directorFactory !== undefined
      ? { directorFactory: options.directorFactory }
      : {}),
    ...(options.greybeardDirectorFactory !== undefined
      ? { greybeardDirectorFactory: options.greybeardDirectorFactory }
      : {}),
    ...(options.greybeardSpawner !== undefined
      ? { greybeardSpawner: options.greybeardSpawner }
      : {}),
    ...(options.operatorResolver !== undefined
      ? { operatorResolver: options.operatorResolver }
      : {}),
  };

  const levelResult = await runLevel(runLevelOptions);
  let working = levelResult.run;

  working = await commitLevel(working, level, {
    worktreePath: levelResult.worktreePath,
    statePath: runStatePath,
  });

  const gateResult = await gate(working, level, buildGateOptions({
    init,
    runDir,
    runStatePath,
    targetRepoPath,
    levelWorktreePath: levelResult.worktreePath,
    options,
  }));
  working = gateResult.run;
  await writeRun(runStatePath, working);

  if (gateResult.outcome === "pass") return working;

  return { ...working, status: "failed" };
}

interface GateOptionsInput {
  readonly init: InitRunResult;
  readonly runDir: string;
  readonly runStatePath: string;
  readonly targetRepoPath: string;
  readonly levelWorktreePath: string;
  readonly options: RunDispatchOptions;
}

function buildGateOptions(input: GateOptionsInput): {
  criticRunner: CriticRunner;
  gateCriticRunner: GateCriticRunner;
  fixAgentRunner: FixAgentRunner;
  rebuildLevel: RebuildCallback;
  awaitOperatorResolution: OperatorResolutionCallback;
  notify?: (message: string) => void;
} {
  const criticRunner =
    input.options.criticRunner ?? buildDefaultCriticRunner(input);
  const gateCriticRunner =
    input.options.gateCriticRunner ?? buildDefaultGateCriticRunner(input);
  const fixAgentRunner =
    input.options.fixAgentRunner ?? buildDefaultFixAgentRunner(input);

  const rebuildLevel: RebuildCallback = async (run, fromLevel) => {
    let next = run;
    const ordered = levelsOf(next).filter((l) => l >= fromLevel);
    for (const level of ordered) {
      next = await commitLevel(next, level, {
        worktreePath: input.levelWorktreePath,
        statePath: input.runStatePath,
      });
    }
    return next;
  };

  const out: ReturnType<typeof buildGateOptions> = {
    criticRunner,
    gateCriticRunner,
    fixAgentRunner,
    rebuildLevel,
    awaitOperatorResolution: buildOperatorResolutionCallback(input.runDir, input.options),
  };
  if (input.options.notify !== undefined) {
    out.notify = input.options.notify;
  }
  return out;
}

/**
 * Default production `CriticRunner`. Spawns `createCriticAgent` against
 * the task's worktree, seeds it with the plan / output / committed diff,
 * and races `agent.send` against the terminal-tool verdict promise so a
 * silently-dying reactor surfaces as a loud error.
 */
function buildDefaultCriticRunner(input: GateOptionsInput): CriticRunner {
  return async ({ run, task, level, round }) => {
    const provider = requireProvider(input.options, "critic");
    const planPath = taskPlanPath(input.runDir, task.id);
    const outputPath = taskOutputPath(input.runDir, task.id);
    const evidencePaths: string[] = [];
    const planMarkdown = await readTextOrEmpty(planPath);
    const outputYAML = await readTextOrEmpty(outputPath);
    const committedDiff = await readGitShow(input.targetRepoPath, task.commitSHA);
    const contextDir = join(
      input.runDir,
      "agent-contexts",
      "critic",
      task.id,
      `round-${String(round)}`,
    );
    const worktreePath = requireTaskWorktreePath(task);

    const seed = buildCriticSeedMessage({
      taskId: task.id,
      level,
      round,
      planMarkdown,
      outputYAML,
      committedDiff,
    });

    const { agent, awaitVerdict } = await createCriticAgent({
      taskWorktreePath: worktreePath,
      taskPlanPath: planPath,
      taskOutputPath: outputPath,
      evidencePaths,
      contextDir,
      model: input.init.config.modelConfig.critic,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      adapter: provider.adapter,
      ...(input.options.deps !== undefined ? { deps: input.options.deps } : {}),
    });

    const drain = drainInferenceErrors(agent, `critic ${task.id} round-${String(round)}`);
    try {
      const sendDone = agent.send(seed).then(() => "send-done" as const);
      const verdict = awaitVerdict.then((value) => ({
        kind: "verdict" as const,
        value,
      }));
      const winner = await Promise.race([sendDone, verdict]);
      if (winner === "send-done") {
        throw new Error(
          `critic agent for task ${task.id} closed without recording a verdict — inspect ${contextDir}/turns.jsonl for diagnostics`,
        );
      }
      void run;
      // The agent-facing schema lacks `round`; the orchestrator stamps
      // it from the caller's round counter. `newTests` is also
      // promoted from optional to a concrete array.
      return {
        round,
        status: winner.value.status,
        findings: winner.value.findings,
        newTests: winner.value.newTests ?? [],
      };
    } finally {
      await agent.close();
      await drain;
    }
  };
}

/**
 * Default production `GateCriticRunner`. Spawns `createGateCriticAgent`
 * against the run directory, seeds it with the level's per-task verdicts,
 * and races `agent.send` against the terminal-tool verdict promise.
 */
function buildDefaultGateCriticRunner(input: GateOptionsInput): GateCriticRunner {
  return async ({ run, level, round, perTaskVerdicts }) => {
    const provider = requireProvider(input.options, "gate-critic");
    const tasksInLevel = run.tasks.filter((t) => t.level === level);
    const taskIds = tasksInLevel.map((t) => t.id);
    const perTaskInputs: PerTaskGateCriticInput[] = tasksInLevel.map((t) => ({
      taskId: t.id,
      planPath: taskPlanPath(input.runDir, t.id),
      outputPath: taskOutputPath(input.runDir, t.id),
      verdictPath: taskVerdictPath(input.runDir, t.id),
      commitSHA: t.commitSHA,
    }));
    const contextDir = join(
      input.runDir,
      "agent-contexts",
      "gate-critic",
      `level-${String(level)}`,
      `round-${String(round)}`,
    );

    const perTaskBlocks: string[] = [];
    for (const entry of perTaskVerdicts) {
      const t = tasksInLevel.find((x) => x.id === entry.taskId);
      const planMarkdown =
        t === undefined ? "" : await readTextOrEmpty(taskPlanPath(input.runDir, t.id));
      const outputYAML =
        t === undefined ? "" : await readTextOrEmpty(taskOutputPath(input.runDir, t.id));
      perTaskBlocks.push(
        buildPerTaskGateBlock({
          taskId: entry.taskId,
          commitSHA: t?.commitSHA ?? null,
          planMarkdown,
          outputYAML,
          verdict: entry.verdict,
        }),
      );
    }
    const seed = buildGateCriticSeedMessage({
      level,
      round,
      taskIds,
      perTaskBlocks,
    });

    const { agent, awaitGateVerdict } = await createGateCriticAgent({
      runDir: input.runDir,
      targetRepoPath: input.targetRepoPath,
      level,
      taskIds,
      perTaskInputs,
      contextDir,
      model: input.init.config.modelConfig.gateCritic,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      adapter: provider.adapter,
      ...(input.options.deps !== undefined ? { deps: input.options.deps } : {}),
    });

    const drain = drainInferenceErrors(
      agent,
      `gate-critic level-${String(level)} round-${String(round)}`,
    );
    try {
      const sendDone = agent.send(seed).then(() => "send-done" as const);
      const verdict = awaitGateVerdict.then((value) => ({
        kind: "verdict" as const,
        value,
      }));
      const winner = await Promise.race([sendDone, verdict]);
      if (winner === "send-done") {
        throw new Error(
          `gate-critic agent for level ${String(level)} closed without recording a verdict — inspect ${contextDir}/turns.jsonl for diagnostics`,
        );
      }
      // The agent-facing schema lacks `round`; the orchestrator stamps
      // it from the caller's round counter.
      return {
        level: winner.value.level,
        round,
        status: winner.value.status,
        perTask: winner.value.perTask,
      };
    } finally {
      await agent.close();
      await drain;
    }
  };
}

/**
 * Default production amendment-loop `FixAgentRunner`. Spawns
 * `createImplementerAgent` (the fix agent reuses the implementer
 * surface — same tools, different seed) against the task's worktree.
 * Returns once `awaitSubmitOutput` resolves; the orchestrator's
 * downstream rebuild picks up the modified files.
 */
function buildDefaultFixAgentRunner(input: GateOptionsInput): FixAgentRunner {
  return async ({ run, task, findings }) => {
    void run;
    const provider = requireProvider(input.options, "fix-agent");
    const worktreePath = requireTaskWorktreePath(task);
    const round = task.amendmentRoundsTotal;
    const contextDir = join(
      input.runDir,
      "agent-contexts",
      "fix-agent",
      task.id,
      `round-${String(round)}`,
    );
    const committedDiff = await readGitShow(input.targetRepoPath, task.commitSHA);
    const seed = buildFixAgentSeed({
      taskId: task.id,
      findings,
      taskPlanMarkdown: task.planMarkdown,
      committedDiff,
    });

    const { agent, awaitSubmitOutput } = await createImplementerAgent({
      worktreePath,
      contextDir,
      model: input.init.config.modelConfig.fixAgent,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      adapter: provider.adapter,
      ...(input.options.deps !== undefined ? { deps: input.options.deps } : {}),
    });

    const drain = drainInferenceErrors(
      agent,
      `fix-agent ${task.id} round-${String(round)}`,
    );
    try {
      const sendDone = agent.send(seed).then(() => "send-done" as const);
      const submitted = awaitSubmitOutput.then((value) => ({
        kind: "submitted" as const,
        value,
      }));
      const winner = await Promise.race([sendDone, submitted]);
      if (winner === "send-done") {
        throw new Error(
          `fix-agent for task ${task.id} closed without calling submitOutput — inspect ${contextDir}/turns.jsonl for diagnostics`,
        );
      }
    } finally {
      await agent.close();
      await drain;
    }
  };
}

function buildOperatorResolutionCallback(
  runDir: string,
  options: RunDispatchOptions,
): OperatorResolutionCallback {
  const resolver = options.operatorResolver;
  if (resolver !== undefined) {
    return async (reason: string) =>
      resolver({ runDir, reason, details: {} });
  }
  return async (reason: string) =>
    awaitOperatorResolution({ runDir, reason });
}

interface VerificationStageInput {
  readonly run: Run;
  readonly init: InitRunResult;
  readonly runDir: string;
  readonly runStatePath: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
}

async function runVerification(input: VerificationStageInput): Promise<Run> {
  const { run, init, runDir, runStatePath, targetRepoPath, options } = input;
  if (run.baselineBuildLogPath === "") {
    // Greenfield bootstrap (`--skip-baseline`): there is nothing to
    // verify against. The brief documents this as the operator's
    // responsibility to backfill before any L2+ task runs; the PoC
    // honours that by treating Phase 5 as a no-op in this state.
    return { ...run, status: "consolidating" };
  }

  const levels = levelsOf(run);
  const lastLevel = levels[levels.length - 1];
  if (lastLevel === undefined) {
    throw new Error("runDispatch: cannot run verification without any levels");
  }
  const lastLevelTask = run.tasks.find(
    (t) => t.level === lastLevel && t.worktreePath !== null,
  );
  const worktreePath = lastLevelTask?.worktreePath;
  if (worktreePath === null || worktreePath === undefined) {
    throw new Error(
      `runDispatch: no worktreePath recorded for any task at level ${String(lastLevel)}; cannot run Phase 5`,
    );
  }

  const buildGateRunner =
    options.buildGateRunner ??
    createDefaultBuildGateRunner({ buildGate: init.config.buildGate });
  const taskVerifier =
    options.taskVerifier ??
    createDefaultTaskVerifier({ buildGate: init.config.buildGate });
  const attributionRunner =
    options.attributionRunner ??
    buildDefaultAttributionRunner({
      init,
      runDir,
      targetRepoPath,
      options,
    });
  const phase5FixAgentRunner =
    options.phase5FixAgentRunner ??
    buildDefaultPhase5FixAgentRunner({
      init,
      runDir,
      targetRepoPath,
      options,
    });

  // Phase 5's attribution agent receives diffs via the orchestrator-rendered
  // seed string. Build the per-task diff map from `git show <commitSHA>` so
  // the attribution agent and fix agent see the actual landed changes.
  const committedDiffsByTaskId = new Map<string, string>();
  for (const task of run.tasks) {
    committedDiffsByTaskId.set(
      task.id,
      await readGitShow(targetRepoPath, task.commitSHA),
    );
  }

  const rebuildLevel: RebuildCallback = async (current, fromLevel) => {
    let next = current;
    const orderedRebuild = levelsOf(next).filter((l) => l >= fromLevel);
    for (const level of orderedRebuild) {
      next = await commitLevel(next, level, {
        worktreePath,
        statePath: runStatePath,
      });
    }
    return next;
  };

  const gateCallback: GateCallback = async ({ run: current, level }) => {
    const result = await gate(current, level, buildGateOptions({
      init,
      runDir,
      runStatePath,
      targetRepoPath,
      levelWorktreePath: worktreePath,
      options,
    }));
    return { run: result.run, outcome: result.outcome };
  };

  const verifyOptions: VerifyAgainstBaselineOptions = {
    worktreePath,
    runDir,
    runStatePath,
    baselineLogPath: run.baselineBuildLogPath,
    buildGateRunner,
    attributionRunner,
    fixAgentRunner: phase5FixAgentRunner,
    taskVerifier,
    rebuildLevel,
    gate: gateCallback,
    awaitOperatorResolution: buildOperatorResolutionCallback(runDir, options),
    committedDiffsByTaskId,
    ...(options.notify !== undefined ? { notify: options.notify } : {}),
    ...(options.verifyMaxLoops !== undefined ? { maxLoops: options.verifyMaxLoops } : {}),
  };

  return verifyAgainstBaseline(run, verifyOptions);
}

async function finalizeReport(
  run: Run,
  runDir: string,
  runStatePath: string,
  now: Date | undefined,
): Promise<Run> {
  await writeRun(runStatePath, run);
  await writeFinalReport(run, now === undefined ? { runDir } : { runDir, now });
  return run;
}

function requireProvider(
  options: RunDispatchOptions,
  stage: string,
): ProviderCredentials {
  const provider = options.provider;
  if (provider === undefined) {
    throw new Error(
      `runDispatch: provider credentials are required to run ${stage} without test overrides`,
    );
  }
  return provider;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrnoEnoent(err)) return false;
    throw err;
  }
}

function isErrnoEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

interface Phase5DefaultRunnerInput {
  readonly init: InitRunResult;
  readonly runDir: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
}

/**
 * Default production `AttributionAgentRunner`. Pre-renders the evidence
 * package via `buildAttributionSeed`, spawns `createAttributionAgent`,
 * and races `agent.send` against the terminal-tool result promise.
 */
function buildDefaultAttributionRunner(
  input: Phase5DefaultRunnerInput,
): AttributionAgentRunner {
  return async ({
    run,
    round,
    baselineLog,
    finalLog,
    newFailures,
    committedDiffsByTaskId,
  }) => {
    const provider = requireProvider(input.options, "attribution");
    const contextDir = join(
      input.runDir,
      "agent-contexts",
      "attribution",
      `round-${String(round)}`,
    );

    const taskBlocks = await Promise.all(
      run.tasks.map(async (t) => {
        const planMarkdown = await readTextOrEmpty(
          taskPlanPath(input.runDir, t.id),
        );
        const outputYAML = await readTextOrEmpty(
          taskOutputPath(input.runDir, t.id),
        );
        return {
          id: t.id,
          objective: t.objective,
          filesModified: t.output?.filesModified ?? [],
          commitSHA: t.commitSHA,
          committedDiff: committedDiffsByTaskId.get(t.id) ?? "",
          planMarkdown,
          outputYAML,
        };
      }),
    );

    const seed = buildAttributionSeed({
      baselineLog,
      finalLog,
      newFailures: newFailures.map((f) => ({
        id: f.id,
        message: f.message,
        file: f.file,
        line: f.line,
      })),
      tasks: taskBlocks,
    });

    const { agent, awaitAttribution } = await createAttributionAgent({
      contextDir,
      model: input.init.config.modelConfig.attribution,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      adapter: provider.adapter,
      ...(input.options.deps !== undefined ? { deps: input.options.deps } : {}),
    });

    const drain = drainInferenceErrors(
      agent,
      `attribution round-${String(round)}`,
    );
    try {
      const sendDone = agent.send(seed).then(() => "send-done" as const);
      const finalize = awaitAttribution.then((value) => ({
        kind: "attribution" as const,
        value,
      }));
      const winner = await Promise.race([sendDone, finalize]);
      if (winner === "send-done") {
        throw new Error(
          `attribution agent closed without calling finalizeAttribution — inspect ${contextDir}/turns.jsonl for diagnostics`,
        );
      }
      return winner.value;
    } finally {
      await agent.close();
      await drain;
    }
  };
}

/**
 * Default production Phase-5 `FixAgentRunner`. Spawns
 * `createImplementerAgent` against the task's worktree with a
 * Phase-5-flavored seed (attribution findings + committed diff).
 * Returns the `filesModified` list extracted from the agent's
 * submitted output so the engine can merge it into the task.
 */
function buildDefaultPhase5FixAgentRunner(
  input: Phase5DefaultRunnerInput,
): Phase5FixAgentRunner {
  return async ({ run, task, findings, committedDiff }) => {
    void run;
    const provider = requireProvider(input.options, "phase5-fix-agent");
    const worktreePath = requireTaskWorktreePath(task);
    const round = task.verificationFixRoundsTotal;
    const contextDir = join(
      input.runDir,
      "agent-contexts",
      "phase5-fix-agent",
      task.id,
      `round-${String(round)}`,
    );
    const seed = buildPhase5FixAgentSeed({
      taskId: task.id,
      findings,
      taskPlanMarkdown: task.planMarkdown,
      committedDiff,
    });

    const { agent, awaitSubmitOutput } = await createImplementerAgent({
      worktreePath,
      contextDir,
      model: input.init.config.modelConfig.fixAgent,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      adapter: provider.adapter,
      ...(input.options.deps !== undefined ? { deps: input.options.deps } : {}),
    });

    const drain = drainInferenceErrors(
      agent,
      `phase5-fix-agent ${task.id} round-${String(round)}`,
    );
    try {
      const sendDone = agent.send(seed).then(() => "send-done" as const);
      const submitted = awaitSubmitOutput.then((value) => ({
        kind: "submitted" as const,
        value,
      }));
      const winner = await Promise.race([sendDone, submitted]);
      if (winner === "send-done") {
        throw new Error(
          `phase5-fix-agent for task ${task.id} closed without calling submitOutput — inspect ${contextDir}/turns.jsonl for diagnostics`,
        );
      }
      return { filesModified: winner.value.filesModified };
    } finally {
      await agent.close();
      await drain;
    }
  };
}

function taskPlanPath(runDir: string, taskId: string): string {
  return join(runDir, "tasks", taskId, "plan.md");
}

function taskOutputPath(runDir: string, taskId: string): string {
  return join(runDir, "tasks", taskId, "output.yaml");
}

function taskVerdictPath(runDir: string, taskId: string): string {
  return join(runDir, "tasks", taskId, "verdict.yaml");
}

function requireTaskWorktreePath(task: Task): string {
  if (task.worktreePath === null) {
    throw new Error(
      `runDispatch: task ${task.id} has no worktreePath; cannot spawn an agent against it`,
    );
  }
  return task.worktreePath;
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoEnoent(err)) return "";
    throw err;
  }
}

/**
 * Run `git show <sha>` in `targetRepoPath` and return stdout. Returns
 * empty string when `commitSHA` is null (zero-file commit unit) so the
 * caller can fold the result straight into a seed-message block.
 */
function readGitShow(
  targetRepoPath: string,
  commitSHA: string | null,
): Promise<string> {
  if (commitSHA === null) return Promise.resolve("");
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", ["show", commitSHA], { cwd: targetRepoPath });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `failed to spawn 'git show ${commitSHA}' in ${targetRepoPath}: ${err.message}`,
          { cause: err },
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git show ${commitSHA} in ${targetRepoPath} exited ${String(code)}: ${stderr}`,
          ),
        );
        return;
      }
      resolvePromise(stdout);
    });
  });
}

/**
 * Drain an agent's event stream, surfacing `inference.error` events to
 * stderr so a 4xx from the provider does not silently drop the reactor.
 * Mirrors the pattern in `plan.ts` / `run-level.ts`.
 */
function drainInferenceErrors(
  agent: { stream(): AsyncIterable<{ type: string; data?: unknown }> },
  label: string,
): Promise<void> {
  return (async () => {
    try {
      for await (const event of agent.stream()) {
        if (event.type === "inference.error") {
          const payload =
            typeof event.data === "object" &&
            event.data !== null &&
            "error" in event.data
              ? (event.data as { error: unknown }).error
              : event.data;
          // eslint-disable-next-line no-console
          console.error(
            `[${label}] inference.error: ${JSON.stringify(payload)}`,
          );
        }
      }
    } catch {
      // The stream throws on agent close; not a failure to surface.
    }
  })();
}

interface CriticSeedInput {
  readonly taskId: string;
  readonly level: number;
  readonly round: number;
  readonly planMarkdown: string;
  readonly outputYAML: string;
  readonly committedDiff: string;
}

function buildCriticSeedMessage(input: CriticSeedInput): string {
  return [
    `You are critiquing task "${input.taskId}" (level ${String(input.level)}, round ${String(input.round)}).`,
    "",
    "Read the evidence below, inspect the worktree via your read-only tools, and call `recordVerdict` exactly once.",
    "",
    "## plan.md",
    "",
    input.planMarkdown,
    "",
    "## output.yaml",
    "",
    "```yaml",
    input.outputYAML,
    "```",
    "",
    "## Committed diff",
    "",
    "```",
    input.committedDiff,
    "```",
  ].join("\n");
}

interface GateCriticSeedInput {
  readonly level: number;
  readonly round: number;
  readonly taskIds: readonly string[];
  readonly perTaskBlocks: readonly string[];
}

function buildGateCriticSeedMessage(input: GateCriticSeedInput): string {
  return [
    `You are gating level ${String(input.level)} (round ${String(input.round)}).`,
    "",
    `Tasks in this level: ${input.taskIds.join(", ")}.`,
    "",
    "Read every per-task block below, use your read-only tools and `gitShow` for any additional evidence, and call `recordGateVerdict` exactly once. The verdict's `perTask` map MUST include every task id above.",
    "",
    input.perTaskBlocks.join("\n\n"),
  ].join("\n");
}

function buildPerTaskGateBlock(input: {
  readonly taskId: string;
  readonly commitSHA: string | null;
  readonly planMarkdown: string;
  readonly outputYAML: string;
  readonly verdict: { status: string; findings: readonly unknown[] };
}): string {
  const sha = input.commitSHA ?? "(no commit yet)";
  return [
    `### Task ${input.taskId}`,
    "",
    `commitSHA: ${sha}`,
    "",
    "#### plan.md",
    "",
    input.planMarkdown,
    "",
    "#### output.yaml",
    "",
    "```yaml",
    input.outputYAML,
    "```",
    "",
    "#### Per-task critic verdict",
    "",
    "```json",
    JSON.stringify(input.verdict, null, 2),
    "```",
  ].join("\n");
}

function buildPhase5FixAgentSeed(input: {
  readonly taskId: string;
  readonly findings: readonly Finding[];
  readonly taskPlanMarkdown: string;
  readonly committedDiff: string;
}): string {
  const findingsBlock =
    input.findings.length === 0
      ? "(no findings; the orchestrator should not have spawned a fix agent here)"
      : input.findings
          .map((f) => {
            const lineRange =
              f.lineRange === null
                ? ""
                : ` (lines ${String(f.lineRange[0])}-${String(f.lineRange[1])})`;
            const filePath =
              f.filePath === null ? "" : ` in ${f.filePath}${lineRange}`;
            return `- [${f.severity}] ${f.id}${filePath}: ${f.description}`;
          })
          .join("\n");
  return [
    `You are amending task "${input.taskId}" in response to Phase-5 build-failure attribution.`,
    "",
    "Your tool surface is identical to the implementer's. You have no git capability; edit files inside the worktree and call `submitOutput` exactly once when finished. The orchestrator rebuilds commits from your edits and re-verifies against the baseline.",
    "",
    "## Attributed failures",
    "",
    findingsBlock,
    "",
    "## Original plan.md",
    "",
    input.taskPlanMarkdown,
    "",
    "## Committed diff",
    "",
    "```",
    input.committedDiff,
    "```",
  ].join("\n");
}

/**
 * Read `dispatch-config.yaml` and verify the locked-policy
 * `commitStrategy` field is absent or set to "per-task". The
 * full validated `DispatchConfig` is still produced via
 * `loadDispatchConfig`; this check exists because that schema
 * deliberately does not enumerate `commitStrategy` (we never use any
 * other value), and the brief requires a loud failure when an
 * operator writes one anyway.
 */
async function assertLockedCommitStrategy(dispatchConfigPath: string): Promise<void> {
  const absolute = resolve(dispatchConfigPath);
  const raw = await readFile(absolute, "utf8");
  const parsed: unknown = parseYAML(raw);
  if (typeof parsed !== "object" || parsed === null) return;
  if (!("commitStrategy" in parsed)) return;
  const value: unknown = (parsed as Record<string, unknown>)["commitStrategy"];
  if (value === "per-task") return;
  throw new Error(
    `dispatch-config at ${absolute} declares commitStrategy=${JSON.stringify(value)}; the PoC is locked to "per-task". Remove the field or set it to "per-task".`,
  );
}

export type { Run, SpecRef };
export { writeFinalReport, renderFinalReport } from "./final-report.js";
export { levelsOf } from "./level-iterator.js";

export { initRun, type InitRunResult } from "./init.js";
export { plan, type PlanOptions, type PlannerOverrideArgs } from "./plan.js";
export {
  loadDispatchConfig,
  dispatchConfigSchema,
  modelConfigSchema,
  type DispatchConfig,
  type ModelConfig,
} from "./config.js";
export {
  captureBaseline,
  parseBuildFailures,
  type CaptureBaselineResult,
} from "./baseline.js";
export {
  ensureIntegrationBranch,
  type EnsureIntegrationBranchResult,
} from "./branch.js";
export {
  runLevel,
  type RunLevelOptions,
  type RunLevelResult,
} from "./run-level.js";
export {
  provisionLevelWorktree,
  tearDownLevelWorktree,
  buildLevelBranchName,
} from "./worktree.js";
export { commitLevel, buildCommitMessage } from "./commit-level.js";
export {
  gate,
  type GateOptions,
  type GateResult,
  type RebuildCallback,
  type OperatorResolutionCallback,
  type CriticRunner,
  type GateCriticRunner,
  type FixAgentRunner,
} from "./gate.js";
export {
  verifyAgainstBaseline,
  type VerifyAgainstBaselineOptions,
  type BuildGateRunner,
  type AttributionAgentRunner,
  type Phase5FixAgentRunner,
  type TaskVerifier,
  type GateCallback,
} from "./phase5/index.js";

