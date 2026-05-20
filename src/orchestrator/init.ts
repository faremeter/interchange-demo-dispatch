// Orchestrator Phase 0 — initRun.
//
// `initRun` is the entry point of a dispatch run. It:
//   1. Loads the dispatch config (`buildGate`, `modelConfig`).
//   2. Ensures the `dispatch/<runName>/` directory exists in the target
//      repo.
//   3. Creates (or reuses) the integration branch via the branch-collision
//      policy.
//   4. Captures the baseline build by running the gate sequentially.
//   5. Persists the resulting `Run` document to disk.
//
// `initRun` accepts an optional `skipBaseline` flag on its `SpecRef`
// input. When set, baseline capture is skipped, `baselineFailures` is the
// empty array, and `baselineBuildLogPath` is recorded as the empty string
// sentinel. The empty-string sentinel is a known PoC compromise — see the
// task's output.yaml deviations for context.
//
// The flag exists for greenfield bootstraps where Task 0 establishes the
// build gate and the orchestrator cannot capture a meaningful baseline
// until after Task 0 has committed. When the operator uses this escape
// hatch, they (or a wrapper script) are responsible for capturing
// baseline manually and updating the run state via `writeRun` before any
// L2+ task runs. The next implementer must notice this contract.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeRun, type Run } from "../state/index.js";

import { captureBaseline } from "./baseline.js";
import { ensureIntegrationBranch } from "./branch.js";
import { loadDispatchConfig, type DispatchConfig } from "./config.js";

export interface SpecRef {
  readonly specPath: string;
  readonly targetRepoPath: string;
  readonly runName: string;
  readonly dispatchConfigPath: string;
  /**
   * When `true`, skip the baseline build capture during `initRun`.
   *
   * This is the explicit escape hatch for greenfield bootstraps where the
   * build gate does not exist yet (e.g. before Task 0 has committed a
   * `package.json`). When set, `baselineFailures` is `[]` and
   * `baselineBuildLogPath` is `""` (empty-string sentinel).
   *
   * Whoever sets this flag MUST capture the baseline manually and update
   * the run state before any L2+ task runs — otherwise Phase 5's
   * "same failures" comparator has nothing to compare against.
   */
  readonly skipBaseline?: boolean;
}

export interface InitRunResult {
  readonly run: Run;
  readonly config: DispatchConfig;
  readonly runStatePath: string;
}

/**
 * Initialize a dispatch run: load config, create the `dispatch/<runName>/`
 * directory under the target repo, create or reuse the integration branch,
 * capture baseline (unless skipped), and persist the initial `Run`
 * document. Returns the populated `Run`, the loaded `DispatchConfig`, and
 * the absolute path to `run-state.yaml`.
 */
export async function initRun(spec: SpecRef): Promise<InitRunResult> {
  const targetRepoPath = resolve(spec.targetRepoPath);
  const config = await loadDispatchConfig(spec.dispatchConfigPath);

  const runDir = join(targetRepoPath, "dispatch", spec.runName);
  await mkdir(runDir, { recursive: true });

  const branchName = `dispatch/${spec.runName}`;
  await ensureIntegrationBranch(targetRepoPath, branchName);

  let baselineBuildLogPath: string;
  let baselineFailures: Run["baselineFailures"];

  if (spec.skipBaseline) {
    baselineBuildLogPath = "";
    baselineFailures = [];
  } else {
    const logPath = join(runDir, "baseline-build.log");
    const captured = await captureBaseline(
      targetRepoPath,
      config.buildGate,
      logPath,
    );
    baselineBuildLogPath = captured.logPath;
    baselineFailures = captured.failures;
  }

  const run: Run = {
    name: spec.runName,
    specPath: spec.specPath,
    targetRepoPath,
    integrationBranch: branchName,
    baselineBuildLogPath,
    baselineFailures,
    commitStrategy: "per-task",
    status: "planning",
    tasks: [],
    levelBoundaries: {},
    gateVerdicts: [],
    verificationRounds: [],
    createdAt: new Date().toISOString(),
  };

  const runStatePath = join(runDir, "run-state.yaml");
  await writeRun(runStatePath, run);

  return { run, config, runStatePath };
}
