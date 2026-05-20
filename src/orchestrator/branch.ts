// Integration-branch creation / reuse for the dispatch orchestrator.
//
// The orchestrator runs every level off a single integration branch named
// after the run (e.g. `dispatch/<runName>`). On a fresh run the branch
// does not yet exist and we create it at `HEAD`. On a resume the branch
// exists from the prior interrupted attempt and we must decide whether to
// reuse it.
//
// Branch-collision policy (per spec.md §332-§375):
//
//   - If the branch does not exist, create it at the current HEAD and
//     return the tip SHA.
//   - If the branch exists and a persisted boundary SHA was supplied,
//     reuse the branch only when its tip equals the boundary. Anything
//     else is a loud failure — divergence means an external mutation we
//     cannot reconcile automatically.
//   - If the branch exists and no boundary was supplied (first-run resume
//     before any boundary has been persisted), reuse the branch only when
//     its tip equals the current HEAD. Otherwise fail loudly.
//
// This module never deletes, force-resets, or moves a branch. The
// operator's escape hatch for "I know what I'm doing, blow it away" is to
// resolve the conflict manually and re-run.

import { spawn } from "node:child_process";

export interface EnsureIntegrationBranchResult {
  readonly tipSHA: string;
  readonly reused: boolean;
}

/**
 * Ensure the integration branch exists on the target repo, applying the
 * branch-collision policy described in this file's header comment.
 *
 * @param targetRepoPath  absolute path to the target repo's working tree.
 * @param branchName      the desired branch name (e.g. `dispatch/<run>`).
 * @param persistedBoundary  the boundary SHA from the persisted run state,
 *                           if any. Pass `undefined` on a first run.
 */
export async function ensureIntegrationBranch(
  targetRepoPath: string,
  branchName: string,
  persistedBoundary?: string,
): Promise<EnsureIntegrationBranchResult> {
  const headSHA = await git(targetRepoPath, ["rev-parse", "HEAD"]);
  const existingTip = await tryBranchTip(targetRepoPath, branchName);

  if (existingTip === null) {
    await git(targetRepoPath, ["branch", branchName, "HEAD"]);
    return { tipSHA: headSHA, reused: false };
  }

  const expected = persistedBoundary ?? headSHA;
  if (existingTip !== expected) {
    const expectedLabel =
      persistedBoundary === undefined
        ? `current HEAD (${headSHA})`
        : `persisted boundary (${persistedBoundary})`;
    throw new Error(
      `branch '${branchName}' already exists at ${existingTip} but expected ${expectedLabel}; refusing to clobber. ` +
        `Resolve manually (inspect the branch, delete or rename it) and re-run.`,
    );
  }

  return { tipSHA: existingTip, reused: true };
}

async function tryBranchTip(
  cwd: string,
  branchName: string,
): Promise<string | null> {
  const result = await runGit(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}`,
  ]);
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  if (result.exitCode === 1) {
    return null;
  }
  throw new Error(
    `git rev-parse --verify refs/heads/${branchName} failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      reject(new Error(`failed to spawn git: ${e.message}`, { cause: e }));
    });
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}
