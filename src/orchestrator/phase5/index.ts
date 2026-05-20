// Phase 5 entry point.
//
// `verifyAgainstBaseline(run, options)` runs the full Phase 5 engine
// (spec.md §455-§630):
//
//   0. Empty-modifications skip — if every completed task at this
//      point has `filesModified: []`, return immediately.
//   1. Run the build gate, captured to
//      `dispatch/<run>/final-build.log-<round>`.
//   2. Compare the gate output to the baseline using the normalizer.
//      If they match, exit Phase 5 (no regression).
//   3. Parse new failures (the set difference between final and
//      baseline failures), spawn the attribution agent, and persist
//      the round's attribution map.
//   4. Per-task fix phase serialized in lex order (delegated to
//      `runFixPhase`).
//   5. Rebuild commits from the earliest affected level via the
//      injected `rebuildLevel` callback (5c's surface).
//   6. Re-run critique on every rebuilt level via the injected
//      `gate` callback (5d's surface). If critique surfaces blocking
//      issues, the nested critique-driven fix loop fires — and 5d's
//      amendment loop handles it because it owns the rebuild
//      callback. Phase 5 just calls `gate(...)` and lets it run.
//   7. Re-verify. Loop back to step 1 until clean or escalation.
//
// Round counters:
//   - `verificationFixRoundsTotal` (per task) is incremented on the
//     round that hits the threshold.
//   - `amendmentRoundsTotal` (per task) is incremented by the
//     amendment loop owned by 5d when the nested critique fix loop
//     runs. This engine does not touch it directly.
//
// Resume semantics (§632-§673) are explicitly NOT implemented here;
// they are owned by `7b-resume`. This forward path assumes the run
// state is fresh from a normal `verifyAgainstBaseline` invocation.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { BuildFailure, Run } from "../../state/index.js";
import { writeRun } from "../../state/index.js";
import { parseBuildFailures } from "../baseline.js";
import type {
  OperatorResolutionCallback,
  RebuildCallback,
} from "../gate.js";

import {
  validateAttributionResult,
  type AttributionResult,
} from "./attribution-agent.js";
import {
  runFixPhase,
  type Phase5FixAgentRunner,
  type TaskVerifier,
} from "./fix-phase.js";
import { normalizeBuildOutput, sameOutput } from "./normalize.js";
import {
  appendVerificationRound,
  earliestAffectedLevel,
} from "./verification-round.js";

/**
 * Runs the configured build gate (or any sequence of shell commands)
 * for a worktree and returns the combined stdout+stderr text. The
 * caller decides which `buildGate` commands to pass — Phase 5 reads
 * them from `dispatch-config.yaml` via the orchestrator's wiring.
 */
export interface BuildGateRunInput {
  readonly run: Run;
  readonly worktreePath: string;
}
export interface BuildGateRunResult {
  readonly output: string;
  readonly exitCode: number | null;
}
export type BuildGateRunner = (
  input: BuildGateRunInput,
) => Promise<BuildGateRunResult>;

/**
 * Spawn an attribution agent for one Phase-5 round and return the
 * resolved attribution map. The orchestrator owns the agent
 * lifecycle; tests pass scripted runners that return canned maps.
 *
 * The runner is given the orchestrator's pre-rendered evidence
 * package — see `buildAttributionSeed` in `attribution-agent.ts`.
 */
export interface AttributionAgentRunnerInput {
  readonly run: Run;
  readonly round: number;
  readonly baselineLog: string;
  readonly finalLog: string;
  readonly newFailures: readonly BuildFailure[];
  readonly committedDiffsByTaskId: ReadonlyMap<string, string>;
}
export type AttributionAgentRunner = (
  input: AttributionAgentRunnerInput,
) => Promise<AttributionResult>;

/**
 * Re-run the per-level gate (delegated to 5d at wire time). The
 * shape mirrors `gate(run, level, options)` from `gate.ts` so the
 * orchestrator can pass it through unchanged. Phase 5 does not
 * import 5d's module directly; it just receives this callback.
 */
export interface GateCallbackInput {
  readonly run: Run;
  readonly level: number;
}
export interface GateCallbackResult {
  readonly run: Run;
  readonly outcome: "pass" | "abort" | "fail";
}
export type GateCallback = (
  input: GateCallbackInput,
) => Promise<GateCallbackResult>;

/**
 * Maximum number of Phase-5 fix-loop iterations before the engine
 * gives up. Independent of the per-task round counters; the
 * counters surface escalation; this cap is an outer safety net.
 *
 * The default is 1 + PHASE5_ESCALATE_ROUND so the operator always
 * gets a chance to weigh in at round 4 before the cap fires.
 */
export const DEFAULT_MAX_VERIFICATION_LOOPS = 5;

export interface VerifyAgainstBaselineOptions {
  /** Absolute path to the level worktree used to run the build gate. */
  readonly worktreePath: string;
  /** Absolute path to the run directory (parent of `final-build.log`). */
  readonly runDir: string;
  /**
   * Absolute path to the run-state YAML for persistence between
   * rounds. The engine calls `writeRun` on every significant state
   * transition so a crash mid-Phase-5 leaves a recoverable state.
   */
  readonly runStatePath: string;
  /** Absolute path to the baseline build log (read-only). */
  readonly baselineLogPath: string;
  /** Build gate runner — same interface for baseline and Phase 5. */
  readonly buildGateRunner: BuildGateRunner;
  /** Attribution agent runner — see field jsdoc above. */
  readonly attributionRunner: AttributionAgentRunner;
  /** Fix agent runner — same shape as `Phase5FixAgentRunner` in fix-phase.ts. */
  readonly fixAgentRunner: Phase5FixAgentRunner;
  /** Per-task verifier — runs `task.verifyCommands`. */
  readonly taskVerifier: TaskVerifier;
  /** Rebuild callback delegated from 5c-commit-level. */
  readonly rebuildLevel: RebuildCallback;
  /** Gate callback delegated from 5d-gate-level (`gate(...)`). */
  readonly gate: GateCallback;
  /** Operator escape hatch. */
  readonly awaitOperatorResolution: OperatorResolutionCallback;
  /** `taskId -> committed diff text` lookup. The orchestrator owns
   *  building this from `git show <commitSHA>`; tests pass a stub. */
  readonly committedDiffsByTaskId: ReadonlyMap<string, string>;
  /** Optional logger sink for round-3 notices. */
  readonly notify?: (message: string) => void;
  /** Optional cap on Phase 5 fix-loop iterations. */
  readonly maxLoops?: number;
  /**
   * Optional extra path prefixes to collapse during normalization
   * (e.g. the run directory or target repo path). Forwarded to
   * `normalizeBuildOutput`.
   */
  readonly normalizeExtraPathPrefixes?: readonly string[];
}

/**
 * Run Phase 5 against `run` and return the updated run state. See
 * file header for the seven-step sequence. The function:
 *
 *   - Throws on infrastructure failures (attribution agent crash,
 *     rebuild callback throws, gate callback throws). The caller
 *     should treat these as escalations.
 *   - Returns with `run.status` set to one of:
 *       - `consolidating` — Phase 5 succeeded; pass control to
 *         Phase 6.
 *       - `failed` — the operator chose abort, a task could not
 *         recover, or the per-loop cap fired.
 *
 * The function persists the run state after every significant
 * transition so a crash leaves a recoverable record.
 */
export async function verifyAgainstBaseline(
  run: Run,
  options: VerifyAgainstBaselineOptions,
): Promise<Run> {
  const maxLoops = options.maxLoops ?? DEFAULT_MAX_VERIFICATION_LOOPS;
  const baselineLog = await readFileText(options.baselineLogPath);
  const normalizeOptions = {
    worktreePath: options.worktreePath,
    ...(options.normalizeExtraPathPrefixes !== undefined
      ? { extraPathPrefixes: options.normalizeExtraPathPrefixes }
      : {}),
  };

  if (everyCompletedTaskHasEmptyFilesModified(run)) {
    const next = setStatus(run, "consolidating");
    await persist(options.runStatePath, next);
    return next;
  }

  let working = setStatus(run, "verifying");
  await persist(options.runStatePath, working);

  for (let loop = 0; loop < maxLoops; loop++) {
    const round = working.verificationRounds.length + 1;
    const buildResult = await options.buildGateRunner({
      run: working,
      worktreePath: options.worktreePath,
    });
    const finalLogPath = join(
      options.runDir,
      `final-build.log-${String(round)}`,
    );
    await mkdir(options.runDir, { recursive: true });
    await writeFile(finalLogPath, buildResult.output, "utf8");

    if (sameOutput(baselineLog, buildResult.output, normalizeOptions)) {
      working = appendVerificationRound({
        run: working,
        finalBuildLogPath: finalLogPath,
        newFailures: [],
        attribution: {},
        rebuildFromLevel: null,
        outcome: "pass",
      });
      working = setStatus(working, "consolidating");
      await persist(options.runStatePath, working);
      return working;
    }

    const newFailures = computeNewFailures(
      baselineLog,
      buildResult.output,
      normalizeOptions,
    );
    if (newFailures.length === 0) {
      // Normalized texts differ but no marker-based failure entries
      // separate them: the spec (§679-§697) prefers acting on a
      // textual difference rather than a parsed one. Treat the
      // round as `retry` and escalate to the operator: the engine
      // cannot attribute a failure it cannot name.
      working = appendVerificationRound({
        run: working,
        finalBuildLogPath: finalLogPath,
        newFailures: [],
        attribution: {},
        rebuildFromLevel: null,
        outcome: "escalated",
      });
      await persist(options.runStatePath, working);
      const resolution = await options.awaitOperatorResolution(
        "Phase 5: normalized build output differs from baseline but no parseable new failures were found",
      );
      if (resolution === "abort") {
        working = setStatus(working, "failed");
        await persist(options.runStatePath, working);
        return working;
      }
      continue;
    }

    working = setStatus(working, "fixing-verification");
    await persist(options.runStatePath, working);

    const attribution = await options.attributionRunner({
      run: working,
      round,
      baselineLog,
      finalLog: buildResult.output,
      newFailures,
      committedDiffsByTaskId: options.committedDiffsByTaskId,
    });
    validateAttributionResult(
      attribution,
      newFailures.map((f) => f.id),
      working.tasks.map((t) => t.id),
    );

    working = appendVerificationRound({
      run: working,
      finalBuildLogPath: finalLogPath,
      newFailures,
      attribution: attribution.attribution,
      rebuildFromLevel: earliestAffectedLevel(working, attribution.attribution),
      outcome: "retry",
    });
    await persist(options.runStatePath, working);

    const failuresById = new Map<string, BuildFailure>();
    for (const f of newFailures) failuresById.set(f.id, f);

    const fixResult = await runFixPhase({
      run: working,
      attribution: attribution.attribution,
      failuresById,
      committedDiffsByTaskId: options.committedDiffsByTaskId,
      fixAgentRunner: options.fixAgentRunner,
      taskVerifier: options.taskVerifier,
      awaitOperatorResolution: options.awaitOperatorResolution,
      ...(options.notify !== undefined ? { notify: options.notify } : {}),
    });
    working = fixResult.run;
    await persist(options.runStatePath, working);

    if (fixResult.outcome === "operator-abort") {
      working = setStatus(working, "failed");
      await persist(options.runStatePath, working);
      return working;
    }
    if (fixResult.outcome === "task-failed") {
      working = setStatus(working, "failed");
      await persist(options.runStatePath, working);
      return working;
    }

    const earliest = earliestAffectedLevel(working, attribution.attribution);
    if (earliest === null) {
      throw new Error(
        "Phase 5: attribution produced no level to rebuild from despite non-empty new failures",
      );
    }
    working = await options.rebuildLevel(working, earliest);
    await persist(options.runStatePath, working);

    const rebuiltLevels = levelsToReGate(working, earliest);
    for (const level of rebuiltLevels) {
      const gateResult = await options.gate({ run: working, level });
      working = gateResult.run;
      await persist(options.runStatePath, working);
      if (gateResult.outcome === "abort") {
        working = setStatus(working, "failed");
        await persist(options.runStatePath, working);
        return working;
      }
      if (gateResult.outcome === "fail") {
        working = setStatus(working, "failed");
        await persist(options.runStatePath, working);
        return working;
      }
    }

    // After rebuild + re-gate, the touched tasks have moved through
    // `completed`. The next loop iteration's empty-modifications
    // check still considers them `completed`, and the next
    // build-gate pass is what closes Phase 5 out.
  }

  // Outer cap fired. The spec treats this as an escalation; surface
  // it to the operator. (The per-task counters already escalate on
  // round 4+, so this branch is mostly a safety net against a
  // pathological attribution that keeps shifting blame between tasks
  // without any one task ever hitting round 4.)
  const resolution = await options.awaitOperatorResolution(
    `Phase 5: outer fix-loop cap (${String(maxLoops)}) reached without converging`,
  );
  if (resolution === "abort") {
    working = setStatus(working, "failed");
  } else {
    working = setStatus(working, "failed");
  }
  await persist(options.runStatePath, working);
  return working;
}

function everyCompletedTaskHasEmptyFilesModified(run: Run): boolean {
  const considered = run.tasks.filter(
    (t) => t.status === "completed" || t.status === "committed",
  );
  if (considered.length === 0) return false;
  return considered.every((t) =>
    t.output === null ? true : t.output.filesModified.length === 0,
  );
}

function setStatus(run: Run, status: Run["status"]): Run {
  return { ...run, status };
}

async function persist(statePath: string, run: Run): Promise<void> {
  const absolute = resolve(statePath);
  await mkdir(dirnameOf(absolute), { recursive: true });
  await writeRun(absolute, run);
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return p.slice(0, idx);
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

/**
 * Compute the set of `BuildFailure`s present in `final` but not in
 * `baseline`. Both inputs are normalized first so volatile substrings
 * (timestamps, paths) do not perturb the comparison.
 *
 * Identity is the failure's stable `id` field (set by
 * `parseBuildFailures` to a hash of file + line + normalized
 * message). The baseline's failure-id set is the universe of
 * "already-broken" failures; anything not in that set is a new
 * failure.
 */
function computeNewFailures(
  baseline: string,
  final: string,
  normalizeOptions: { worktreePath: string; extraPathPrefixes?: readonly string[] },
): BuildFailure[] {
  const normalizedBaseline = normalizeBuildOutput(baseline, normalizeOptions);
  const normalizedFinal = normalizeBuildOutput(final, normalizeOptions);
  const baselineFailures = parseBuildFailures(normalizedBaseline);
  const finalFailures = parseBuildFailures(normalizedFinal);
  const known = new Set(baselineFailures.map((f) => f.id));
  return finalFailures.filter((f) => !known.has(f.id));
}

/**
 * Levels to re-run critique on after a rebuild starting at
 * `fromLevel`. The brief (§588) is "every rebuilt level with
 * critiqueEnabled tasks". Phase 5 leaves enablement to 5d's gate
 * callback (which already handles `critiqueEnabled`), so this
 * function just enumerates the levels.
 */
function levelsToReGate(run: Run, fromLevel: number): number[] {
  const levels = new Set<number>();
  for (const t of run.tasks) {
    if (t.level >= fromLevel) levels.add(t.level);
  }
  return Array.from(levels).sort((a, b) => a - b);
}

export {
  normalizeBuildOutput,
  sameOutput,
} from "./normalize.js";
export {
  buildAttributionTools,
  buildAttributionSeed,
  createAttributionAgent,
  validateAttributionResult,
  recordAttributionArgsSchema,
  finalizeAttributionArgsSchema,
  type AttributionAgent,
  type AttributionAgentHandle,
  type AttributionResult,
  type AttributionSeedInput,
  type CreateAttributionAgentOptions,
} from "./attribution-agent.js";
export {
  runFixPhase,
  PHASE5_ESCALATE_ROUND,
  PHASE5_NOTIFY_ROUND,
  type Phase5FixAgentRunner,
  type TaskVerifier,
  type TaskVerifierInput,
  type TaskVerifierResult,
  type RunFixPhaseOptions,
  type RunFixPhaseResult,
} from "./fix-phase.js";
export {
  appendVerificationRound,
  replaceLatestVerificationRound,
  earliestAffectedLevel,
  attributedTaskIds,
} from "./verification-round.js";

// Re-export for callers that need the Task shape without re-importing
// from state.
export type { Run, Task } from "../../state/index.js";
