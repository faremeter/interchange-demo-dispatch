// Phase 6 — consolidate.
//
// After every level's work is committed onto its per-level branch
// (`dispatch/<runName>-level-<N>`) and Phase 5 has signed off, the
// orchestrator transitions the run to `consolidating`. The only thing
// that needs to happen in that state is the integration branch's tip
// catching up to the last level's tip so the operator can `git merge
// dispatch/<runName>` (or fast-forward main from it) in a single step.
//
// Before this module existed, the orchestrator flipped the status
// straight from `consolidating` to `done` with no git activity. The
// per-level branches accumulated commits correctly but
// `dispatch/<runName>` stayed pinned at whatever `initRun` left it at,
// so the final integration branch contained zero of the run's work.
// The CLI's report.md said the run was `done` and listed the per-task
// commit SHAs, but the named integration branch was effectively a
// dangling pointer.
//
// `consolidate` is idempotent: running it twice in a row produces no
// additional git activity (the second `update-ref` is a no-op because
// the integration branch is already at the target tip). The resume
// path from `consolidating` can therefore re-enter it without special
// handling.

import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import { writeRun } from "../state/persist.js";
import type { Run } from "../state/types.js";

import { levelsOf } from "./level-iterator.js";
import { buildLevelBranchName, type GitExecutor } from "./worktree.js";

export interface ConsolidateOptions {
  /** Absolute path to the target repo (where the integration branch lives). */
  readonly repoRoot: string;
  /** Absolute path to the run-state YAML for persistence. */
  readonly runStatePath: string;
  /** Injectable git executor; tests pass a deterministic stub. */
  readonly gitExecutor?: GitExecutor;
}

/**
 * Fast-forward the run's integration branch to the highest level's tip
 * and transition the run to `done`. Writes the updated state file.
 *
 * Throws on any of:
 *   - the persisted run has no tasks (planner produced nothing; should
 *     have errored upstream);
 *   - the highest-level branch doesn't resolve (someone pruned it
 *     between the level's commit and consolidate);
 *   - the integration branch has advanced past where we'd point it
 *     (non-fast-forward — indicates concurrent operator activity or
 *     a bug elsewhere; we refuse to clobber).
 *
 * Returns the updated `Run` with `status: "done"`.
 */
export async function consolidate(
  run: Run,
  options: ConsolidateOptions,
): Promise<Run> {
  const git = options.gitExecutor ?? defaultGitExecutor;
  const repoRoot = resolvePath(options.repoRoot);

  const levels = levelsOf(run);
  if (levels.length === 0) {
    throw new Error(
      `consolidate: run "${run.name}" has no levels; the planner stage must have errored before reaching this point`,
    );
  }
  const lastLevel = levels[levels.length - 1];
  if (lastLevel === undefined) {
    throw new Error(
      `consolidate: internal — levelsOf returned a non-empty array with undefined tail for run "${run.name}"`,
    );
  }

  const lastLevelBranch = buildLevelBranchName(run.name, lastLevel);
  const lastLevelTip = await readBranchTip(git, repoRoot, lastLevelBranch);
  if (lastLevelTip === null) {
    throw new Error(
      `consolidate: last-level branch "${lastLevelBranch}" did not resolve in ${repoRoot}; cannot fast-forward integration branch`,
    );
  }

  const integrationTip = await readBranchTip(
    git,
    repoRoot,
    run.integrationBranch,
  );

  if (integrationTip !== lastLevelTip) {
    // Refuse a non-fast-forward. The integration branch's tip either
    // hasn't been updated yet (the normal case — we'll update it
    // below) or it's somewhere we don't recognise (operator pushed,
    // bug elsewhere). The check we need is: lastLevelTip's ancestry
    // includes integrationTip. If it doesn't, we'd be discarding
    // commits, which is a loud-failure case.
    if (integrationTip !== null) {
      const isAncestor = await branchIsAncestor(
        git,
        repoRoot,
        integrationTip,
        lastLevelTip,
      );
      if (!isAncestor) {
        throw new Error(
          `consolidate: integration branch "${run.integrationBranch}" is at ${integrationTip} which is not an ancestor of last-level tip ${lastLevelTip} (branch "${lastLevelBranch}"). Refusing to clobber. Inspect ${repoRoot} for concurrent activity.`,
        );
      }
    }

    const updateResult = await git({
      args: [
        "update-ref",
        `refs/heads/${run.integrationBranch}`,
        lastLevelTip,
        ...(integrationTip !== null ? [integrationTip] : []),
      ],
      cwd: repoRoot,
    });
    if (updateResult.exitCode !== 0) {
      throw new Error(
        `consolidate: git update-ref for ${run.integrationBranch} → ${lastLevelTip} exited ${String(
          updateResult.exitCode,
        )}: ${updateResult.stderr.trim()}`,
      );
    }
  }

  const next: Run = { ...run, status: "done" };
  await writeRun(options.runStatePath, next);
  return next;
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
  return tip.length === 0 ? null : tip;
}

async function branchIsAncestor(
  git: GitExecutor,
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git({
    args: ["merge-base", "--is-ancestor", ancestor, descendant],
    cwd,
  });
  return result.exitCode === 0;
}

const defaultGitExecutor: GitExecutor = ({ args, cwd }) => {
  return new Promise((resolve, reject) => {
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
