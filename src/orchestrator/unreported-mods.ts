// Post-fan-in unreported-modifications check.
//
// After every implementer in a level has submitted (or been marked failed), the
// orchestrator collects every modified file in the level worktree via
// `git status --porcelain` and verifies that each entry is claimed by some
// successful task's `filesModified`. A file that is dirty on disk but not
// claimed by any task is a bug: either an implementer wrote files outside its
// declared scope (path-escape should have prevented this) or a task crashed
// mid-write. Either way the run must fail loudly so the operator can
// investigate.
//
// `git status --porcelain` is used instead of `git diff` so untracked files
// are included. Implementer agents have no git capability, so staged entries
// would already represent a contract violation — but the porcelain output
// folds tracked-modified, staged, and untracked into the same scan.

import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

/**
 * Result of a porcelain scan. `unclaimed` lists modified worktree-relative
 * paths that no successful task claimed via `filesModified`. `ok` is true
 * iff `unclaimed` is empty.
 */
export interface UnreportedModificationsResult {
  ok: boolean;
  unclaimed: string[];
  modifiedPaths: string[];
}

export interface CheckUnreportedModificationsOptions {
  /** Absolute path to the level's git worktree. */
  worktreePath: string;
  /**
   * The union of every successful task's `filesModified` array, expressed as
   * worktree-relative paths. The orchestrator builds this from each task's
   * persisted `TaskOutput.filesModified` after Karen's per-task loop finishes.
   */
  claimedFiles: readonly string[];
  /**
   * Optional injectable executor for `git status --porcelain`. Production
   * callers leave this undefined and get the default `child_process.spawn`
   * implementation. Tests inject a fake that returns scripted porcelain
   * output without touching the filesystem.
   */
  gitStatusExecutor?: GitStatusExecutor;
}

export interface GitStatusExecutorArgs {
  cwd: string;
}

export interface GitStatusResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitStatusExecutor = (
  args: GitStatusExecutorArgs,
) => Promise<GitStatusResult>;

/**
 * Run `git status --porcelain` inside `worktreePath` and compare the modified
 * file set to `claimedFiles`. Any modified path not in the claimed set lands
 * in `unclaimed`.
 *
 * The porcelain parser handles the three forms that appear in `--porcelain=v1`
 * output:
 *
 *   - ` M path/to/file`          (modified, unstaged)
 *   - `M  path/to/file`          (modified, staged)
 *   - `?? path/to/file`          (untracked)
 *   - `R  oldpath -> newpath`    (rename; both old and new are reported as
 *                                 modified for claim purposes)
 *
 * Paths are returned exactly as porcelain emits them (worktree-relative,
 * forward-slash even on Windows). Quoted paths (containing whitespace or
 * special characters when `core.quotePath` is on) are not unquoted; the PoC
 * documents this and recommends `git config core.quotePath off` on the
 * orchestrator's git binary. If a quoted path appears, the comparison falls
 * through and the path lands in `unclaimed`, surfacing the configuration
 * issue loudly rather than silently misattributing.
 */
export async function checkUnreportedModifications(
  options: CheckUnreportedModificationsOptions,
): Promise<UnreportedModificationsResult> {
  const exec = options.gitStatusExecutor ?? defaultGitStatusExecutor;
  const result = await exec({ cwd: options.worktreePath });
  if (result.exitCode !== 0) {
    throw new Error(
      `git status --porcelain in ${options.worktreePath} exited ${String(
        result.exitCode,
      )}: ${result.stderr.trim()}`,
    );
  }

  const modifiedPaths = parsePorcelain(result.stdout);
  const claimed = new Set(
    options.claimedFiles.map((p) => normalizeClaim(p, options.worktreePath)),
  );
  const unclaimed = modifiedPaths.filter((p) => !claimed.has(p));
  return { ok: unclaimed.length === 0, modifiedPaths, unclaimed };
}

function normalizeClaim(claimed: string, worktreePath: string): string {
  // Claimed paths may arrive as absolute (path-escape returns absolute), as
  // worktree-relative (the implementer's submitted form), or as paths with
  // back-slashes on Windows. Normalize all to forward-slash worktree-relative
  // for comparison against porcelain output.
  const abs = resolvePath(worktreePath, claimed);
  const root = resolvePath(worktreePath);
  if (abs === root) return "";
  if (abs.startsWith(`${root}/`)) {
    return abs.slice(root.length + 1).split("\\").join("/");
  }
  // A claim that resolves outside the worktree is a contract violation but
  // not this function's job to police — return the original so it won't
  // match anything porcelain emits and surfaces via downstream checks.
  return claimed;
}

function parsePorcelain(stdout: string): string[] {
  const out: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    if (rawLine.length === 0) continue;
    // Porcelain v1: XY<space>path, with renames as `R  old -> new`. We treat
    // the path field as starting at column 3.
    if (rawLine.length < 4) continue;
    const status = rawLine.slice(0, 2);
    const rest = rawLine.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) {
      const arrow = rest.indexOf(" -> ");
      if (arrow !== -1) {
        const oldPath = rest.slice(0, arrow);
        const newPath = rest.slice(arrow + 4);
        if (oldPath.length > 0) out.push(oldPath);
        if (newPath.length > 0) out.push(newPath);
        continue;
      }
    }
    if (rest.length > 0) out.push(rest);
  }
  return out;
}

const defaultGitStatusExecutor: GitStatusExecutor = ({ cwd }) => {
  return new Promise<GitStatusResult>((resolve, reject) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd });
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
