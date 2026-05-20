import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureIntegrationBranch } from "./branch";

let workDir: string;

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
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: exit=${String(r.exitCode)} stderr=${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intx-orch-branch-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "# test\n", "utf8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

beforeEach(async () => {
  workDir = await initRepo();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("ensureIntegrationBranch", () => {
  test("creates the branch at HEAD when it does not exist", async () => {
    const head = await git(workDir, ["rev-parse", "HEAD"]);
    const result = await ensureIntegrationBranch(workDir, "dispatch/test-run");
    expect(result.tipSHA).toBe(head);
    expect(result.reused).toBe(false);
    const tip = await git(workDir, ["rev-parse", "refs/heads/dispatch/test-run"]);
    expect(tip).toBe(head);
  });

  test("reuses the branch when its tip equals HEAD on first run (no boundary)", async () => {
    const head = await git(workDir, ["rev-parse", "HEAD"]);
    await git(workDir, ["branch", "dispatch/test-run", "HEAD"]);
    const result = await ensureIntegrationBranch(workDir, "dispatch/test-run");
    expect(result.tipSHA).toBe(head);
    expect(result.reused).toBe(true);
  });

  test("fails when the branch tip diverges from HEAD on first run", async () => {
    await git(workDir, ["branch", "dispatch/test-run", "HEAD"]);
    // Advance the branch's tip beyond HEAD.
    await writeFile(join(workDir, "extra.txt"), "x\n", "utf8");
    await git(workDir, ["checkout", "-q", "dispatch/test-run"]);
    await git(workDir, ["add", "extra.txt"]);
    await git(workDir, ["commit", "-q", "-m", "advance branch"]);
    await git(workDir, ["checkout", "-q", "main"]);

    let thrown: unknown = null;
    try {
      await ensureIntegrationBranch(workDir, "dispatch/test-run");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toContain("already exists at");
    expect(thrown.message).toContain("refusing to clobber");
  });

  test("reuses the branch when its tip matches the persisted boundary", async () => {
    await git(workDir, ["branch", "dispatch/test-run", "HEAD"]);
    // Advance branch beyond HEAD; the boundary should track the advanced tip.
    await git(workDir, ["checkout", "-q", "dispatch/test-run"]);
    await writeFile(join(workDir, "extra.txt"), "x\n", "utf8");
    await git(workDir, ["add", "extra.txt"]);
    await git(workDir, ["commit", "-q", "-m", "advance"]);
    const advancedTip = await git(workDir, ["rev-parse", "HEAD"]);
    await git(workDir, ["checkout", "-q", "main"]);

    const result = await ensureIntegrationBranch(
      workDir,
      "dispatch/test-run",
      advancedTip,
    );
    expect(result.tipSHA).toBe(advancedTip);
    expect(result.reused).toBe(true);
  });

  test("fails when the branch tip diverges from the persisted boundary", async () => {
    await git(workDir, ["branch", "dispatch/test-run", "HEAD"]);
    const head = await git(workDir, ["rev-parse", "HEAD"]);
    const fakeBoundary = "0".repeat(40);

    let thrown: unknown = null;
    try {
      await ensureIntegrationBranch(workDir, "dispatch/test-run", fakeBoundary);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toContain(head);
    expect(thrown.message).toContain(fakeBoundary);
  });
});
