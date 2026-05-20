// Per-level git worktree provisioning.
//
// Each level in a run gets a dedicated `git worktree` rooted at
// `dispatch/<runName>/worktrees/level-<N>/`, on a branch named
// `dispatch/<runName>/level-<N>`. All implementers in that level share the
// same worktree filesystem (so the produced commit captures every change in
// one place); each implementer gets its own `agent-ctx/` directory passed via
// `contextDir` for isolation.
//
// Branch-collision policy (per spec §369-§385):
//
//   - If the branch does not exist: create it off the post-prior-level
//     boundary (or off the integration branch's tip for level 1).
//   - If the branch exists and its tip matches the persisted
//     `levelBoundaries[level]`: reuse it (this is the resume case).
//   - If the branch exists and its tip does NOT match the persisted boundary:
//     fail loudly. The orchestrator never auto-cleans.
//
// Working-tree-clean precheck: provisioning is followed by a porcelain scan
// of the worktree. A non-clean tree is a precondition violation (resume task
// 7b owns recovery); this module reports the failure but does not attempt
// repair.
//
// All git invocations go through an injectable executor so tests can drive
// the branching logic without a real repo. Production callers leave the
// executor undefined and get a `child_process.spawn`-based default.

import { realpath as fsRealpath } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";

import type { Run } from "../state/types.js";

export interface ProvisionLevelWorktreeOptions {
  /** Loaded run-state. Read-only here; the orchestrator persists boundary updates elsewhere. */
  run: Run;
  /** Level number being provisioned (1-indexed, matching `levelBoundaries`). */
  level: number;
  /**
   * Absolute path to the target repository (the repo the dispatch is operating
   * on). This is `Run.targetRepoPath`; threaded explicitly so callers can
   * provide a normalized path.
   */
  repoRoot: string;
  /**
   * Absolute path to the run's dispatch directory, typically
   * `<repoRoot>/dispatch/<runName>`. The level worktree is created beneath
   * `<runDir>/worktrees/level-<N>/`.
   */
  runDir: string;
  /**
   * Optional injectable git executor. Production callers leave undefined and
   * get the default `spawn`-based implementation.
   */
  gitExecutor?: GitExecutor;
}

export interface ProvisionLevelWorktreeResult {
  /** Absolute path to the level worktree. */
  worktreePath: string;
  /** Branch name created (or reused) for the level. */
  branchName: string;
  /** Commit SHA the branch points at. */
  tipSHA: string;
  /** True iff the branch was created by this call; false on reuse. */
  created: boolean;
}

export interface TearDownLevelWorktreeOptions {
  worktreePath: string;
  repoRoot: string;
  gitExecutor?: GitExecutor;
}

export interface GitExecutorArgs {
  args: string[];
  cwd: string;
}

export interface GitExecutorResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitExecutor = (args: GitExecutorArgs) => Promise<GitExecutorResult>;

/**
 * Reusable porcelain scan. Returns the raw porcelain output; the caller
 * decides what counts as "clean". `provisionLevelWorktree` uses it for the
 * working-tree-clean precheck.
 */
export async function getWorktreePorcelainStatus(
  worktreePath: string,
  gitExecutor: GitExecutor = defaultGitExecutor,
): Promise<string> {
  const result = await gitExecutor({
    args: ["status", "--porcelain"],
    cwd: worktreePath,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git status --porcelain in ${worktreePath} exited ${String(
        result.exitCode,
      )}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Provision (or reuse) the level worktree per the branch-collision policy
 * documented at the top of this file. On success the returned object names
 * the absolute worktree path, the branch, and the commit tip. The caller
 * persists the tip into `Run.levelBoundaries` after a successful commit
 * (commit ownership lives in 5c, not here).
 */
export async function provisionLevelWorktree(
  options: ProvisionLevelWorktreeOptions,
): Promise<ProvisionLevelWorktreeResult> {
  const git = options.gitExecutor ?? defaultGitExecutor;
  const branchName = buildLevelBranchName(options.run.name, options.level);
  const worktreePath = resolvePath(
    options.runDir,
    "worktrees",
    `level-${String(options.level)}`,
  );

  const existingTip = await readBranchTip(git, options.repoRoot, branchName);
  const persistedBoundary = options.run.levelBoundaries[options.level];

  let created: boolean;
  let tipSHA: string;
  if (existingTip === null) {
    const baseRef = await resolveBaseRef(
      git,
      options.repoRoot,
      options.run,
      options.level,
    );
    await mkdir(dirname(worktreePath), { recursive: true });
    const addResult = await git({
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: options.repoRoot,
    });
    if (addResult.exitCode !== 0) {
      throw new Error(
        `git worktree add for ${branchName} at ${worktreePath} exited ${String(
          addResult.exitCode,
        )}: ${addResult.stderr.trim()}`,
      );
    }
    const tip = await readBranchTip(git, options.repoRoot, branchName);
    if (tip === null) {
      throw new Error(
        `provisionLevelWorktree: branch ${branchName} could not be resolved after creation`,
      );
    }
    tipSHA = tip;
    created = true;
  } else {
    if (persistedBoundary !== undefined && existingTip !== persistedBoundary) {
      throw new Error(
        `branch ${branchName} exists but its tip ${existingTip} does not match the persisted boundary ${persistedBoundary}; refusing to reuse. Resume the run via the dedicated resume verb.`,
      );
    }
    const registered = await findRegisteredWorktreeForBranch(
      git,
      options.repoRoot,
      branchName,
    );
    if (registered === null) {
      await mkdir(dirname(worktreePath), { recursive: true });
      const addResult = await git({
        args: ["worktree", "add", worktreePath, branchName],
        cwd: options.repoRoot,
      });
      if (addResult.exitCode !== 0) {
        throw new Error(
          `git worktree add for existing branch ${branchName} at ${worktreePath} exited ${String(
            addResult.exitCode,
          )}: ${addResult.stderr.trim()}`,
        );
      }
    } else if (!(await pathsRefSameLocation(registered, worktreePath))) {
      throw new Error(
        `branch ${branchName} is already checked out at ${registered}, not at the expected ${worktreePath}; refusing to reuse. Tear down the stale worktree before retrying.`,
      );
    }
    tipSHA = existingTip;
    created = false;
  }

  // Working-tree-clean precheck: a freshly-provisioned worktree must have an
  // empty porcelain output. Anything else indicates the level is in an
  // inconsistent state — fail loudly; resume (7b) owns recovery.
  const porcelain = await getWorktreePorcelainStatus(worktreePath, git);
  if (porcelain.trim().length !== 0) {
    throw new Error(
      `working-tree-clean precheck failed for ${worktreePath}: porcelain status is non-empty:\n${porcelain}`,
    );
  }

  return { worktreePath, branchName, tipSHA, created };
}

/**
 * Tear down a level worktree. Invoked by the CLI verb that explicitly cleans
 * up a run's filesystem footprint — never by `runLevel` itself, which leaves
 * the worktree in place so subsequent levels can re-enter it and so the
 * operator can inspect failure state.
 */
export async function tearDownLevelWorktree(
  options: TearDownLevelWorktreeOptions,
): Promise<void> {
  const git = options.gitExecutor ?? defaultGitExecutor;
  const result = await git({
    args: ["worktree", "remove", "--force", options.worktreePath],
    cwd: options.repoRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git worktree remove ${options.worktreePath} exited ${String(
        result.exitCode,
      )}: ${result.stderr.trim()}`,
    );
  }
}

/**
 * Branch naming convention: `dispatch/<runName>/level-<N>`. Lifted from the
 * spec's isolation section so callers in other files (notably `commitLevel`
 * in 5c) can recompute the same name without a circular import.
 */
export function buildLevelBranchName(runName: string, level: number): string {
  return `dispatch/${runName}/level-${String(level)}`;
}

/**
 * Compare two filesystem paths for equality after resolving symlinks. macOS
 * routinely returns `/private/var/...` for `/var/...` from `git worktree
 * list`, so a string-equality check would spuriously diverge. The function
 * falls back to the original strings when `realpath` cannot resolve either
 * side (e.g., the path no longer exists).
 */
async function pathsRefSameLocation(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  let realA = a;
  let realB = b;
  try {
    realA = await fsRealpath(a);
  } catch {
    realA = a;
  }
  try {
    realB = await fsRealpath(b);
  } catch {
    realB = b;
  }
  return realA === realB;
}

/**
 * Look up the absolute path of the worktree currently checked out on
 * `branchName`. Returns `null` if no worktree is registered for the branch.
 * Used by the reuse path so a second `git worktree add` is not attempted for
 * a branch that is already attached to a worktree on disk.
 */
async function findRegisteredWorktreeForBranch(
  git: GitExecutor,
  cwd: string,
  branchName: string,
): Promise<string | null> {
  const result = await git({
    args: ["worktree", "list", "--porcelain"],
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git worktree list --porcelain in ${cwd} exited ${String(
        result.exitCode,
      )}: ${result.stderr.trim()}`,
    );
  }
  const target = `refs/heads/${branchName}`;
  let pendingPath: string | null = null;
  for (const rawLine of result.stdout.split("\n")) {
    if (rawLine.startsWith("worktree ")) {
      pendingPath = rawLine.slice("worktree ".length).trim();
      continue;
    }
    if (rawLine.startsWith("branch ")) {
      const ref = rawLine.slice("branch ".length).trim();
      if (ref === target && pendingPath !== null) return pendingPath;
      continue;
    }
    if (rawLine.length === 0) pendingPath = null;
  }
  return null;
}

async function readBranchTip(
  git: GitExecutor,
  cwd: string,
  branchName: string,
): Promise<string | null> {
  const result = await git({
    args: ["rev-parse", "--verify", `refs/heads/${branchName}`],
    cwd,
  });
  if (result.exitCode !== 0) return null;
  const tip = result.stdout.trim();
  if (tip.length === 0) return null;
  return tip;
}

async function resolveBaseRef(
  git: GitExecutor,
  cwd: string,
  run: Run,
  level: number,
): Promise<string> {
  if (level <= 1) {
    return run.integrationBranch;
  }
  const priorBoundary = run.levelBoundaries[level - 1];
  if (priorBoundary === undefined) {
    throw new Error(
      `provisionLevelWorktree: level ${String(
        level,
      )} requested but levelBoundaries[${String(level - 1)}] is not yet persisted`,
    );
  }
  // Verify the boundary still resolves to a commit; surface missing-history
  // failures loudly here rather than after `worktree add` produces a less
  // readable error.
  const verify = await git({
    args: ["rev-parse", "--verify", `${priorBoundary}^{commit}`],
    cwd,
  });
  if (verify.exitCode !== 0) {
    throw new Error(
      `prior level boundary ${priorBoundary} does not resolve in ${cwd}: ${verify.stderr.trim()}`,
    );
  }
  return priorBoundary;
}

const defaultGitExecutor: GitExecutor = ({ args, cwd }) => {
  return new Promise<GitExecutorResult>((resolve, reject) => {
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
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
};

