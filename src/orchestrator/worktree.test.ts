// Tests for `provisionLevelWorktree` / `tearDownLevelWorktree` against a real
// fixture git repo.
//
// The branch-collision policy is exercised in three forms:
//
//   1. Fresh branch: the branch does not exist; `provision` creates it off
//      the prior boundary (or the integration branch on level 1) and the
//      working tree is clean.
//   2. Reuse with matching tip: the branch already exists at the persisted
//      boundary; `provision` reuses it.
//   3. Conflict with different tip: the branch exists but its tip drifted
//      away from the persisted boundary; `provision` fails loudly.
//
// We also assert the working-tree-clean precheck rejects a dirty tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import type { Run } from "../state/types.js";
import {
  buildLevelBranchName,
  provisionLevelWorktree,
  tearDownLevelWorktree,
} from "./worktree.js";

function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveResult, reject) => {
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
      resolveResult({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} in ${cwd} exited ${String(
        result.exitCode,
      )}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

// Level branches use a dash separator (`dispatch/<run>-level-N`) so they
// do not collide with the integration branch `dispatch/<run>` — git refuses
// to have both `dispatch/foo` and `dispatch/foo/level-1` as refs at the
// same time. With the dash form, both fit in the `dispatch/` namespace
// without conflict, so we can use the production integration branch name
// in tests.
const INTEGRATION_BRANCH = "dispatch/test-run";
const RUN_NAME = "test-run";

function makeRun(name: string, boundaries: Record<number, string> = {}): Run {
  return {
    name,
    specPath: "/dev/null",
    targetRepoPath: "/dev/null",
    integrationBranch: INTEGRATION_BRANCH,
    baselineBuildLogPath: "/dev/null",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "executing",
    tasks: [],
    levelBoundaries: boundaries,
    gateVerdicts: [],
    verificationRounds: [],
    createdAt: new Date().toISOString(),
  };
}

let workRoot: string;
let repoRoot: string;
let runDir: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "intx-worktree-test-"));
  repoRoot = resolvePath(workRoot, "repo");
  runDir = join(repoRoot, "dispatch", RUN_NAME);
  await gitOrThrow(workRoot, ["init", "--initial-branch=main", "repo"]);
  await gitOrThrow(repoRoot, ["config", "user.email", "test@example.com"]);
  await gitOrThrow(repoRoot, ["config", "user.name", "test"]);
  await writeFile(join(repoRoot, "README.md"), "# fixture\n");
  await gitOrThrow(repoRoot, ["add", "README.md"]);
  await gitOrThrow(repoRoot, ["commit", "-m", "init"]);
  await gitOrThrow(repoRoot, ["branch", INTEGRATION_BRANCH]);
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("provisionLevelWorktree", () => {
  test("creates a fresh branch off the integration branch for level 1", async () => {
    const run = makeRun(RUN_NAME);
    const result = await provisionLevelWorktree({
      run,
      level: 1,
      repoRoot,
      runDir,
    });
    expect(result.created).toBe(true);
    expect(result.branchName).toBe(buildLevelBranchName(RUN_NAME, 1));
    expect(result.worktreePath).toBe(join(runDir, "worktrees", "level-1"));

    const integrationTip = await gitOrThrow(repoRoot, [
      "rev-parse",
      INTEGRATION_BRANCH,
    ]);
    expect(result.tipSHA).toBe(integrationTip);
  });

  test("creates a level-2 branch off the prior level's persisted boundary", async () => {
    // Establish a "level 1" commit on a branch that becomes the boundary.
    const priorBranch = "dispatch/test-run-level-1";
    await gitOrThrow(repoRoot, ["branch", priorBranch]);
    await gitOrThrow(repoRoot, ["checkout", priorBranch]);
    await writeFile(join(repoRoot, "L1.txt"), "level 1\n");
    await gitOrThrow(repoRoot, ["add", "L1.txt"]);
    await gitOrThrow(repoRoot, ["commit", "-m", "L1"]);
    const priorBoundary = await gitOrThrow(repoRoot, [
      "rev-parse",
      priorBranch,
    ]);
    await gitOrThrow(repoRoot, ["checkout", "main"]);

    // levelBoundaries[N] is the pre-level-N boundary. For level 2, that's
    // the post-level-1 HEAD.
    const run = makeRun(RUN_NAME, { 2: priorBoundary });
    const result = await provisionLevelWorktree({
      run,
      level: 2,
      repoRoot,
      runDir,
    });
    expect(result.created).toBe(true);
    expect(result.tipSHA).toBe(priorBoundary);
  });

  test("reuses a branch whose tip matches the persisted boundary", async () => {
    const branchName = buildLevelBranchName(RUN_NAME, 1);
    // Create the branch in the repo and remember its tip.
    await gitOrThrow(repoRoot, ["branch", branchName]);
    const tip = await gitOrThrow(repoRoot, ["rev-parse", branchName]);

    const run = makeRun(RUN_NAME, { 1: tip });
    const result = await provisionLevelWorktree({
      run,
      level: 1,
      repoRoot,
      runDir,
    });
    expect(result.created).toBe(false);
    expect(result.tipSHA).toBe(tip);
  });

  test("fails loudly when the branch tip drifts from the persisted boundary", async () => {
    const branchName = buildLevelBranchName(RUN_NAME, 1);
    await gitOrThrow(repoRoot, ["branch", branchName]);
    const initialTip = await gitOrThrow(repoRoot, ["rev-parse", branchName]);
    // Advance the branch so the tip drifts from `initialTip`.
    await gitOrThrow(repoRoot, ["checkout", branchName]);
    await writeFile(join(repoRoot, "drift.txt"), "drift\n");
    await gitOrThrow(repoRoot, ["add", "drift.txt"]);
    await gitOrThrow(repoRoot, ["commit", "-m", "drift"]);
    await gitOrThrow(repoRoot, ["checkout", "main"]);

    const run = makeRun(RUN_NAME, { 1: initialTip });
    await expect(
      provisionLevelWorktree({
        run,
        level: 1,
        repoRoot,
        runDir,
      }),
    ).rejects.toThrow(/does not match the persisted boundary/);
  });

  test("working-tree-clean precheck rejects a dirty fresh worktree", async () => {
    const branchName = buildLevelBranchName(RUN_NAME, 1);
    const worktreePath = join(runDir, "worktrees", "level-1");
    // Pre-create the worktree manually with the branch, then dirty it.
    await gitOrThrow(repoRoot, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
    ]);
    const tip = await gitOrThrow(repoRoot, ["rev-parse", branchName]);
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n");

    const run = makeRun(RUN_NAME, { 1: tip });
    await expect(
      provisionLevelWorktree({
        run,
        level: 1,
        repoRoot,
        runDir,
      }),
    ).rejects.toThrow(/working-tree-clean precheck failed/);
  });
});

describe("tearDownLevelWorktree", () => {
  test("removes a previously provisioned worktree", async () => {
    const run = makeRun(RUN_NAME);
    const provisioned = await provisionLevelWorktree({
      run,
      level: 1,
      repoRoot,
      runDir,
    });
    await tearDownLevelWorktree({
      worktreePath: provisioned.worktreePath,
      repoRoot,
    });
    const list = await gitOrThrow(repoRoot, ["worktree", "list"]);
    expect(list).not.toContain(provisioned.worktreePath);
  });
});
