// Resume entry point — recover a previously-interrupted run from disk.
//
// `resume(runDir)` is the callback `runDispatch` consults when it finds a
// `run-state.yaml` already in the run directory. The function loads the
// persisted document, inspects the on-disk artifacts produced by the
// orchestrator's forward path, classifies the interruption into one of the
// seven cases enumerated by spec.md §632-§677, and applies a deterministic
// recovery for that case. The seven cases are:
//
//   1. Mid-task implementer (`task.status === "running"`, `agent-ctx/` on
//      disk). Kill the stale context directory and reset the task to
//      `pending` so the next forward pass re-spawns it from the seed.
//   2. Between submitOutput and state-file write (`task.status === "running"`
//      AND the task's `output.yaml` exists). The spec accepts wasted work:
//      delete both `agent-ctx/` and the orphan `output.yaml` and reset the
//      task to `pending`.
//   3. Fix-agent crashed with uncommitted changes (`task.status === "fixing"`
//      and the level worktree has a dirty diff). Revert the worktree to
//      `task.commitSHA` and leave the task in `fixing` so the next forward
//      pass re-spawns the fix agent based on `fixingSource`.
//   4. Mid-rebuild between commits within a level. For each level whose
//      tasks are all "committed" on paper but whose `commitSHA`s do not
//      uniformly appear in `git log` from `levelBoundaries[level]`, reset
//      every task at-or-after the first missing SHA back to `submitted` so
//      the rebuild restarts at the right point.
//   5. Between commit and boundary write. For each level whose tasks are
//      `committed` and the worktree HEAD doesn't match (or is missing
//      from) `levelBoundaries[level+1]`, recompute the boundary from
//      `git rev-parse HEAD`.
//   6. Between baseline capture and Phase 1 start (status === "planning",
//      no tasks yet). Re-enter planning — no on-disk cleanup needed.
//   7. Mid-Phase-5 fix loop. A `final-build.log-<N>` exists for a round N
//      that never received a `VerificationRound` entry. Detach the orphan
//      log (delete from disk; the next round writes a fresh one).
//
// Anything that doesn't unambiguously match exactly one case throws
// `ResumeAmbiguousError` (code `RESUME_AMBIGUOUS`). The brief is explicit
// that "no case is allowed to silently accept an inconsistent state."
//
// Contract gap with 7a-orchestrator-loop:
//
//   `runDispatch` consumes `resume`'s return value strictly: a `done` or
//   `failed` run short-circuits the call; any other status throws. The
//   resume callback signature `(runDir: string) => Promise<Run>` only
//   gives us the run directory — we cannot continue the forward path
//   from inside resume (no provider creds, no scripted runners, no
//   directors). Resume's job here is therefore on-disk consolidation:
//   normalize the persisted state so a subsequent invocation of
//   `runDispatch` (with the appropriate options) can pick up cleanly.
//   See `dispatch/intx-dispatch-poc/7b-resume/output.yaml`'s deviation
//   note for the corresponding follow-up.

import { rm, stat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { loadRun, writeRun } from "../state/index.js";
import type { Run, Task } from "../state/index.js";

import type { GitExecutor, GitExecutorResult } from "./worktree.js";

import { detectCase1Tasks, recoverCase1 } from "./resume/case-1-running-task.js";
import { detectCase2Tasks, recoverCase2 } from "./resume/case-2-submitoutput-race.js";
import { detectCase3Tasks, recoverCase3 } from "./resume/case-3-fixing.js";
import { detectCase4Levels, recoverCase4 } from "./resume/case-4-mid-rebuild.js";
import { detectCase5Levels, recoverCase5 } from "./resume/case-5-boundary.js";
import { detectCase6, recoverCase6 } from "./resume/case-6-pre-plan.js";
import { detectCase7Logs, recoverCase7 } from "./resume/case-7-phase5-mid-round.js";

export const RESUME_AMBIGUOUS = "RESUME_AMBIGUOUS";

/**
 * Thrown when the persisted state and the on-disk artifacts together cannot
 * be classified into exactly one of the seven recovery cases. Carries the
 * evidence the operator needs to inspect (the loaded `Run`, the detection
 * matches per case) so the failure is self-diagnosing.
 */
export class ResumeAmbiguousError extends Error {
  override name = "ResumeAmbiguousError";
  /** Machine-readable code, exposed for switch/case handling by callers. */
  readonly code = RESUME_AMBIGUOUS;

  constructor(
    public readonly evidence: ResumeAmbiguityEvidence,
  ) {
    super(buildAmbiguousMessage(evidence));
  }
}

export interface ResumeAmbiguityEvidence {
  /** The persisted run name (for log lines / operator triage). */
  readonly runName: string;
  /** The persisted run status. */
  readonly runStatus: Run["status"];
  /** Cases that matched, in order. More than one match is ambiguous. */
  readonly matchedCases: readonly ResumeCaseMatch[];
  /** Free-form reason if no case matched but the state is non-terminal. */
  readonly reason: string;
}

export interface ResumeCaseMatch {
  /** Case number per the spec's seven-case enumeration. */
  readonly case: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Per-case identifiers (task ids, level numbers, etc.) the detector caught. */
  readonly evidence: readonly string[];
}

/**
 * Optional injection seam for the git executor. Tests pass a stub so the
 * worktree-revert and git-log walks don't shell out to real git. Production
 * callers leave this undefined and get the default `spawn`-based executor.
 */
export interface ResumeOptions {
  readonly gitExecutor?: GitExecutor;
}

/**
 * Entry point matching the `runDispatch` resume-callback contract. Loads
 * the persisted run state, classifies the interruption, applies the
 * deterministic recovery, persists the consolidated state, and returns it.
 *
 * Throws `ResumeAmbiguousError` on multi-case matches or on a non-terminal
 * state that no case explains.
 */
export async function resume(runDir: string): Promise<Run> {
  return resumeWithOptions(runDir, {});
}

/**
 * Same as `resume(runDir)` but with the test-injection seam exposed.
 * `resume(runDir)` is the production-callable; `resumeWithOptions` is the
 * test surface — same code path, no behavioural divergence.
 */
export async function resumeWithOptions(
  runDir: string,
  options: ResumeOptions,
): Promise<Run> {
  const absoluteRunDir = resolve(runDir);
  const runStatePath = join(absoluteRunDir, "run-state.yaml");
  const run = await loadRun(runStatePath);

  if (run.status === "done" || run.status === "failed") {
    return run;
  }

  const gitExecutor = options.gitExecutor ?? defaultGitExecutor;

  const case1 = await detectCase1Tasks(run, absoluteRunDir);
  const case2 = await detectCase2Tasks(run, absoluteRunDir);
  const case3 = await detectCase3Tasks(run, { gitExecutor });
  const case4 = await detectCase4Levels(run, { gitExecutor });
  const case5 = await detectCase5Levels(run, { gitExecutor });
  const case6 = detectCase6(run);
  const case7 = await detectCase7Logs(run, absoluteRunDir);

  // Cases 1-7 are orthogonal: they describe disjoint pieces of evidence
  // (per-task statuses, per-level commit logs, run-wide orphan logs).
  // Multiple may match in a single resume — each is recovered
  // independently, in a deterministic order that respects the spec's
  // sequencing (cleanup-then-rebuild-then-boundary-then-orphan).
  // Ambiguity is the case where the run is non-terminal and NO case
  // matches: that's an unrecognised state and we refuse to guess.
  const matches: ResumeCaseMatch[] = [];
  if (case1.length > 0) matches.push({ case: 1, evidence: case1 });
  if (case2.length > 0) matches.push({ case: 2, evidence: case2 });
  if (case3.length > 0) matches.push({ case: 3, evidence: case3 });
  if (case4.length > 0) matches.push({ case: 4, evidence: case4 });
  if (case5.length > 0) matches.push({ case: 5, evidence: case5 });
  if (case6) matches.push({ case: 6, evidence: [] });
  if (case7.length > 0) matches.push({ case: 7, evidence: case7 });

  if (matches.length === 0) {
    throw new ResumeAmbiguousError({
      runName: run.name,
      runStatus: run.status,
      matchedCases: [],
      reason: `run-state at ${runStatePath} is non-terminal (status="${run.status}") but no interruption case matched the on-disk evidence; operator must inspect`,
    });
  }

  let next = run;
  // Recovery order:
  //   1. Per-task cleanup (cases 1, 2) — kills stale agent contexts and
  //      orphan output.yaml files, resets tasks to `pending`.
  //   2. Fix-agent revert (case 3) — hard-resets worktrees back to
  //      commitSHA so re-spawned fix agents start from a clean tree.
  //   3. Mid-rebuild recovery (case 4) — resets stale `committed` tasks
  //      back to `submitted` so the rebuild restarts at the right point.
  //   4. Boundary recompute (case 5) — fills in the post-level SHA from
  //      HEAD.
  //   5. Pre-plan re-entry (case 6) — pure pass-through.
  //   6. Orphan-log cleanup (case 7) — removes final-build.log-<N> with
  //      no matching VerificationRound entry.
  if (case1.length > 0) {
    next = await recoverCase1(next, absoluteRunDir, case1, { runRemove: defaultRunRemove });
  }
  if (case2.length > 0) {
    next = await recoverCase2(next, absoluteRunDir, case2, { runRemove: defaultRunRemove });
  }
  if (case3.length > 0) {
    next = await recoverCase3(next, case3, { gitExecutor });
  }
  if (case4.length > 0) {
    next = await recoverCase4(next, case4);
  }
  if (case5.length > 0) {
    next = await recoverCase5(next, case5, { gitExecutor });
  }
  if (case6) {
    next = recoverCase6(next);
  }
  if (case7.length > 0) {
    next = await recoverCase7(next, absoluteRunDir, case7, { runRemove: defaultRunRemove });
  }

  await writeRun(runStatePath, next);
  return next;
}

/**
 * Shared cleanup primitive surfaced to case handlers so the same code
 * path runs in tests (where it's spied on) and production. Recursive,
 * idempotent.
 */
async function defaultRunRemove(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/** Convenience: best-effort `stat` returning `null` for ENOENT. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if (isErrnoEnoent(err)) return false;
    throw err;
  }
}

/** Convenience: directory listing returning `[]` for ENOENT. */
export async function readDirOrEmpty(target: string): Promise<string[]> {
  try {
    return await readdir(target);
  } catch (err) {
    if (isErrnoEnoent(err)) return [];
    throw err;
  }
}

export function isErrnoEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Shared helper used by case handlers: return the latest level worktree
 * path for a given level. Mirrors the worktree-naming convention from
 * `worktree.ts` (`<runDir>/worktrees/level-<N>/`).
 */
export function levelWorktreePath(runDir: string, level: number): string {
  return join(runDir, "worktrees", `level-${String(level)}`);
}

/**
 * Walk `git log` from `fromSHA` (exclusive) and return the SHAs reachable
 * via `--first-parent`. Used by case 4 to verify which `commitSHA`s landed
 * during a partial rebuild.
 */
export async function gitLogFromBoundary(
  worktreePath: string,
  fromSHA: string,
  gitExecutor: GitExecutor,
): Promise<string[]> {
  const result = await gitExecutor({
    args: ["log", "--first-parent", "--format=%H", `${fromSHA}..HEAD`],
    cwd: worktreePath,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git log ${fromSHA}..HEAD in ${worktreePath} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length !== 0);
}

/** Read HEAD's SHA from `worktreePath`. */
export async function gitHeadSHA(
  worktreePath: string,
  gitExecutor: GitExecutor,
): Promise<string> {
  const result = await gitExecutor({
    args: ["rev-parse", "HEAD"],
    cwd: worktreePath,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git rev-parse HEAD in ${worktreePath} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Porcelain status of `worktreePath`. Returns the raw `--porcelain` output;
 * callers decide what counts as clean. Empty string === clean.
 */
export async function gitPorcelainStatus(
  worktreePath: string,
  gitExecutor: GitExecutor,
): Promise<string> {
  const result = await gitExecutor({
    args: ["status", "--porcelain"],
    cwd: worktreePath,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git status --porcelain in ${worktreePath} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Hard-reset `worktreePath` to `targetSHA` and clean untracked files. Used
 * by case 3 to discard the fix agent's uncommitted edits before re-
 * spawning it. `git reset --hard` only restores tracked-file state; the
 * subsequent `git clean -fd` removes untracked files the fix agent may
 * have created (e.g. new source files it didn't get to commit). `.gitignore`
 * entries are preserved (no `-x`) so node_modules and similar bulky paths
 * aren't accidentally wiped.
 */
export async function gitHardReset(
  worktreePath: string,
  targetSHA: string,
  gitExecutor: GitExecutor,
): Promise<void> {
  const reset = await gitExecutor({
    args: ["reset", "--hard", targetSHA],
    cwd: worktreePath,
  });
  if (reset.exitCode !== 0) {
    throw new Error(
      `git reset --hard ${targetSHA} in ${worktreePath} exited ${String(reset.exitCode)}: ${reset.stderr.trim()}`,
    );
  }
  const clean = await gitExecutor({
    args: ["clean", "-fd"],
    cwd: worktreePath,
  });
  if (clean.exitCode !== 0) {
    throw new Error(
      `git clean -fd in ${worktreePath} exited ${String(clean.exitCode)}: ${clean.stderr.trim()}`,
    );
  }
}

/**
 * Convenience: clone a `Run` with a single task replaced. Case handlers use
 * this to keep the surface immutable.
 */
export function withTask(run: Run, taskId: string, mutate: (t: Task) => Task): Run {
  let found = false;
  const tasks = run.tasks.map((t) => {
    if (t.id !== taskId) return t;
    found = true;
    return mutate(t);
  });
  if (!found) {
    throw new Error(`resume: task "${taskId}" not present in run "${run.name}"`);
  }
  return { ...run, tasks };
}

/** Surface to case handlers for filesystem mutation, injectable in tests. */
export interface ResumeFsHooks {
  readonly runRemove: (target: string) => Promise<void>;
}

function buildAmbiguousMessage(evidence: ResumeAmbiguityEvidence): string {
  if (evidence.matchedCases.length === 0) {
    return `${RESUME_AMBIGUOUS}: ${evidence.reason}`;
  }
  const cases = evidence.matchedCases
    .map((m) => `case ${String(m.case)}[${m.evidence.join(",")}]`)
    .join(", ");
  return `${RESUME_AMBIGUOUS}: ${evidence.reason} (matched: ${cases})`;
}

const defaultGitExecutor: GitExecutor = ({ args, cwd }) => {
  return new Promise<GitExecutorResult>((resolveFn, rejectFn) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      rejectFn(err);
    });
    child.on("close", (code) => {
      resolveFn({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
};
