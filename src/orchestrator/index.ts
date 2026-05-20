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

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parse as parseYAML } from "yaml";

import { loadRun, writeRun } from "../state/index.js";
import type { Run } from "../state/index.js";

import { initRun, type InitRunResult, type SpecRef } from "./init.js";
import { plan, type PlanOptions, type PlannerOverrideArgs } from "./plan.js";
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
  verifyAgainstBaseline,
  type AttributionAgentRunner,
  type BuildGateRunner,
  type GateCallback,
  type Phase5FixAgentRunner,
  type TaskVerifier,
  type VerifyAgainstBaselineOptions,
} from "./phase5/index.js";
import { awaitOperatorResolution } from "./operator-escalation.js";
import { levelsOf } from "./level-iterator.js";
import { writeFinalReport } from "./final-report.js";
import type { GreybeardSpawner, OperatorResolver } from "./karen-loop.js";

export interface ProviderCredentials {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly provider?: string;
}

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
    throw new Error(
      `runDispatch: run-state.yaml at ${runStatePath} exists with status "${resumed.status}"; resume support is not wired (waiting on 7b-resume)`,
    );
  }

  const init = await initRun(spec);

  const planned = await runPlanStage({
    init,
    runDir,
    targetRepoPath,
    options,
  });

  const levels = levelsOf(planned);
  if (levels.length === 0) {
    throw new Error(
      `runDispatch: planner produced no tasks for run "${spec.runName}"`,
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
      contextDirRoot,
      plannerOverride: options.plannerOverride,
    };
  }

  const provider = requireProvider(options, "plan");
  const base: PlanOptions = {
    config: init.config,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    contextDirRoot,
  };
  if (provider.provider !== undefined) {
    return { ...base, provider: provider.provider };
  }
  return base;
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
  const provider = options.provider;
  const runLevelOptions: RunLevelOptions = {
    run,
    level,
    repoRoot: targetRepoPath,
    runDir,
    runStatePath,
    model: init.config.modelConfig.implementer,
    baseURL: provider?.baseURL ?? "test://unused",
    apiKey: provider?.apiKey ?? "test-unused",
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
  const criticRunner = input.options.criticRunner;
  const gateCriticRunner = input.options.gateCriticRunner;
  const fixAgentRunner = input.options.fixAgentRunner;
  if (criticRunner === undefined) {
    throw new Error(
      "runDispatch: criticRunner override is required; production critic wiring is not implemented in the PoC",
    );
  }
  if (gateCriticRunner === undefined) {
    throw new Error(
      "runDispatch: gateCriticRunner override is required; production gate-critic wiring is not implemented in the PoC",
    );
  }
  if (fixAgentRunner === undefined) {
    throw new Error(
      "runDispatch: fixAgentRunner override is required; production fix-agent wiring is not implemented in the PoC",
    );
  }

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
  readonly runDir: string;
  readonly runStatePath: string;
  readonly targetRepoPath: string;
  readonly options: RunDispatchOptions;
}

async function runVerification(input: VerificationStageInput): Promise<Run> {
  const { run, runDir, runStatePath, targetRepoPath, options } = input;
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

  const buildGateRunner = options.buildGateRunner;
  const attributionRunner = options.attributionRunner;
  const phase5FixAgentRunner = options.phase5FixAgentRunner;
  const taskVerifier = options.taskVerifier;
  if (buildGateRunner === undefined) {
    throw new Error(
      "runDispatch: buildGateRunner override is required; production build-gate wiring is not implemented in the PoC",
    );
  }
  if (attributionRunner === undefined) {
    throw new Error(
      "runDispatch: attributionRunner override is required; production attribution-agent wiring is not implemented in the PoC",
    );
  }
  if (phase5FixAgentRunner === undefined) {
    throw new Error(
      "runDispatch: phase5FixAgentRunner override is required; production fix-agent wiring is not implemented in the PoC",
    );
  }
  if (taskVerifier === undefined) {
    throw new Error(
      "runDispatch: taskVerifier override is required; production verifier wiring is not implemented in the PoC",
    );
  }

  // Phase 5's attribution agent receives diffs via the orchestrator-rendered
  // seed string (see 6a-phase5-engine notes). In the PoC's scripted-runner
  // test path the runners never inspect the actual diff text; production
  // wiring (deferred) will populate this from `git show <commitSHA>`.
  const committedDiffsByTaskId = new Map<string, string>();
  for (const task of run.tasks) {
    committedDiffsByTaskId.set(task.id, "");
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

