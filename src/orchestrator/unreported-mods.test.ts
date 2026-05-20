// Tests for `checkUnreportedModifications`.
//
// The function is a pure parse-and-compare over `git status --porcelain`
// output; tests inject a fake git executor that returns deterministic
// porcelain strings so the assertions exercise the parser/claimer without a
// real repo.

import { describe, expect, test } from "bun:test";

import {
  checkUnreportedModifications,
  type GitStatusExecutor,
  type GitStatusResult,
} from "./unreported-mods.js";

function executor(stdout: string, exitCode = 0): GitStatusExecutor {
  return async (): Promise<GitStatusResult> => ({
    stdout,
    stderr: "",
    exitCode,
  });
}

describe("checkUnreportedModifications", () => {
  test("ok when every modified file is claimed", async () => {
    const result = await checkUnreportedModifications({
      worktreePath: "/tmp/wt",
      claimedFiles: ["a.ts", "b.ts"],
      gitStatusExecutor: executor(" M a.ts\n?? b.ts\n"),
    });
    expect(result.ok).toBe(true);
    expect(result.unclaimed).toEqual([]);
    expect(result.modifiedPaths.sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("not ok when a modified file is not claimed by anyone", async () => {
    const result = await checkUnreportedModifications({
      worktreePath: "/tmp/wt",
      claimedFiles: ["a.ts"],
      gitStatusExecutor: executor(" M a.ts\n?? rogue.ts\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.unclaimed).toEqual(["rogue.ts"]);
  });

  test("partial claim: one task claimed a.ts but b.ts is rogue", async () => {
    const result = await checkUnreportedModifications({
      worktreePath: "/tmp/wt",
      claimedFiles: ["a.ts"],
      gitStatusExecutor: executor(" M a.ts\n M b.ts\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.unclaimed).toEqual(["b.ts"]);
  });

  test("absolute-path claims normalize to worktree-relative for matching", async () => {
    const worktreePath = "/tmp/wt";
    const result = await checkUnreportedModifications({
      worktreePath,
      claimedFiles: [`${worktreePath}/a.ts`],
      gitStatusExecutor: executor(" M a.ts\n"),
    });
    expect(result.ok).toBe(true);
  });

  test("rename lines list both old and new paths", async () => {
    const result = await checkUnreportedModifications({
      worktreePath: "/tmp/wt",
      claimedFiles: ["old.ts", "new.ts"],
      gitStatusExecutor: executor("R  old.ts -> new.ts\n"),
    });
    expect(result.ok).toBe(true);
    expect(result.modifiedPaths.sort()).toEqual(["new.ts", "old.ts"]);
  });

  test("rename lines fail when only the new path is claimed", async () => {
    const result = await checkUnreportedModifications({
      worktreePath: "/tmp/wt",
      claimedFiles: ["new.ts"],
      gitStatusExecutor: executor("R  old.ts -> new.ts\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.unclaimed).toEqual(["old.ts"]);
  });

  test("staged + unstaged modifications produce one entry each", async () => {
    const result = await checkUnreportedModifications({
      worktreePath: "/tmp/wt",
      claimedFiles: ["a.ts", "b.ts"],
      gitStatusExecutor: executor("M  a.ts\n M b.ts\n"),
    });
    expect(result.ok).toBe(true);
  });

  test("empty porcelain output means no modifications and no unclaimed", async () => {
    const result = await checkUnreportedModifications({
      worktreePath: "/tmp/wt",
      claimedFiles: [],
      gitStatusExecutor: executor(""),
    });
    expect(result.ok).toBe(true);
    expect(result.modifiedPaths).toEqual([]);
    expect(result.unclaimed).toEqual([]);
  });

  test("non-zero git exit code surfaces as an exception", async () => {
    const exec: GitStatusExecutor = async () => ({
      stdout: "",
      stderr: "not a git repo",
      exitCode: 128,
    });
    await expect(
      checkUnreportedModifications({
        worktreePath: "/tmp/wt",
        claimedFiles: [],
        gitStatusExecutor: exec,
      }),
    ).rejects.toThrow(/exited 128/);
  });
});
