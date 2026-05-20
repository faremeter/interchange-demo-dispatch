import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAddAndCommit } from "./git-commit.js";

function run(
  cwd: string,
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}

async function initRepo(dir: string): Promise<void> {
  let result = await run(dir, "git", ["init", "--initial-branch=main", "."]);
  expect(result.code).toBe(0);
  // Configure identity locally so commits succeed regardless of host config.
  result = await run(dir, "git", ["config", "user.email", "test@example.com"]);
  expect(result.code).toBe(0);
  result = await run(dir, "git", ["config", "user.name", "Test User"]);
  expect(result.code).toBe(0);
  // Disable any global hooks path that might interfere.
  result = await run(dir, "git", ["config", "core.hooksPath", ".git/hooks"]);
  expect(result.code).toBe(0);
  // Create an initial commit so HEAD exists.
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  result = await run(dir, "git", ["add", "README.md"]);
  expect(result.code).toBe(0);
  result = await run(dir, "git", ["commit", "-m", "seed"]);
  expect(result.code).toBe(0);
}

async function headSHA(dir: string): Promise<string> {
  const r = await run(dir, "git", ["rev-parse", "HEAD"]);
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

async function showFormat(dir: string, sha: string, fmt: string): Promise<string> {
  const r = await run(dir, "git", ["show", "-s", `--format=${fmt}`, sha]);
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "intx-git-commit-"));
  await initRepo(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("gitAddAndCommit", () => {
  test("stages files and creates a commit, returning the new SHA", async () => {
    await writeFile(join(workDir, "a.txt"), "alpha\n", "utf8");
    await writeFile(join(workDir, "b.txt"), "beta\n", "utf8");

    const before = await headSHA(workDir);
    const sha = await gitAddAndCommit({
      worktreePath: workDir,
      files: ["a.txt", "b.txt"],
      message: "Add alpha and beta",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const after = await headSHA(workDir);
    expect(sha).toEqual(after);
    expect(sha).not.toEqual(before);

    const subject = await showFormat(workDir, sha, "%s");
    expect(subject).toEqual("Add alpha and beta");

    const filesChanged = await run(workDir, "git", [
      "show",
      "--name-only",
      "--format=",
      sha,
    ]);
    expect(filesChanged.stdout.trim().split("\n").sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  test("rejects an empty files list rather than creating an empty commit", async () => {
    let thrown: unknown = null;
    try {
      await gitAddAndCommit({
        worktreePath: workDir,
        files: [],
        message: "should not happen",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toMatch(/at least one file/);
  });

  test("commit messages survive quoting edge cases", async () => {
    await writeFile(join(workDir, "tricky.txt"), "x\n", "utf8");
    const tricky = `Adopt "quoted" \`backticks\` and $SHELL traps`;
    const sha = await gitAddAndCommit({
      worktreePath: workDir,
      files: ["tricky.txt"],
      message: tricky,
    });
    const subject = await showFormat(workDir, sha, "%s");
    expect(subject).toEqual(tricky);
  });

  test("multi-line messages preserve summary and body", async () => {
    await writeFile(join(workDir, "multi.txt"), "x\n", "utf8");
    const message = "Summary line\n\nBody paragraph one.\n\nBody paragraph two.";
    const sha = await gitAddAndCommit({
      worktreePath: workDir,
      files: ["multi.txt"],
      message,
    });
    const subject = await showFormat(workDir, sha, "%s");
    const body = await showFormat(workDir, sha, "%b");
    expect(subject).toEqual("Summary line");
    expect(body).toContain("Body paragraph one.");
    expect(body).toContain("Body paragraph two.");
  });

  test("respects a passing pre-commit hook (no --no-verify)", async () => {
    const hooks = join(workDir, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    const hookPath = join(hooks, "pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\necho hook-ran >&2\nexit 0\n",
      "utf8",
    );
    await chmod(hookPath, 0o755);

    await writeFile(join(workDir, "ok.txt"), "ok\n", "utf8");
    const sha = await gitAddAndCommit({
      worktreePath: workDir,
      files: ["ok.txt"],
      message: "Commit with passing hook",
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("fails when a pre-commit hook rejects the change", async () => {
    const hooks = join(workDir, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    const hookPath = join(hooks, "pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n",
      "utf8",
    );
    await chmod(hookPath, 0o755);

    await writeFile(join(workDir, "rejected.txt"), "nope\n", "utf8");
    const before = await headSHA(workDir);

    let thrown: unknown = null;
    try {
      await gitAddAndCommit({
        worktreePath: workDir,
        files: ["rejected.txt"],
        message: "should be rejected by hook",
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toMatch(/git commit/);

    // HEAD must not have moved.
    const after = await headSHA(workDir);
    expect(after).toEqual(before);

    // The file the hook rejected should still be on disk and unstaged or
    // staged depending on git's behavior — but no commit exists.
    const log = await run(workDir, "git", ["log", "--oneline"]);
    expect(log.stdout.trim().split("\n")).toHaveLength(1);

    // Sanity: the staged content can still be inspected.
    const content = await readFile(join(workDir, "rejected.txt"), "utf8");
    expect(content).toEqual("nope\n");
  });

  test("--allow-empty is not used: a commit with no real changes still fails", async () => {
    // Create the file, commit it, then call again with the same file. The
    // second call has nothing to stage, so git commit refuses (no
    // --allow-empty).
    await writeFile(join(workDir, "once.txt"), "once\n", "utf8");
    await gitAddAndCommit({
      worktreePath: workDir,
      files: ["once.txt"],
      message: "First commit",
    });

    let thrown: unknown = null;
    try {
      await gitAddAndCommit({
        worktreePath: workDir,
        files: ["once.txt"],
        message: "Empty repeat",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
