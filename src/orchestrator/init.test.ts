import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRun } from "../state/index.js";

import { initRun } from "./init";

let workDir: string;

function runGit(cwd: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
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
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

const validConfigYaml = `
buildGate:
  - echo build-ran
modelConfig:
  planner: opencode-go/kimi-k2.6
  implementer: opencode-go/kimi-k2.6
  critic: opencode-go/kimi-k2.6
  gateCritic: opencode-go/kimi-k2.6
  greybeard: opencode-go/kimi-k2.6
  attribution: opencode-go/kimi-k2.6
  fixAgent: opencode-go/kimi-k2.6
`;

async function setupTargetRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intx-orch-init-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "# test\n", "utf8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-q", "-m", "initial"]);
  await writeFile(join(dir, "spec.md"), "# spec\n\nDo things.\n", "utf8");
  await writeFile(join(dir, "dispatch-config.yaml"), validConfigYaml, "utf8");
  return dir;
}

beforeEach(async () => {
  workDir = await setupTargetRepo();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("initRun", () => {
  test("creates dispatch dir, branch, captures baseline, persists Run", async () => {
    const result = await initRun({
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "test-run",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    });

    expect(result.run.name).toBe("test-run");
    expect(result.run.status).toBe("planning");
    expect(result.run.commitStrategy).toBe("per-task");
    expect(result.run.tasks).toEqual([]);
    expect(result.run.levelBoundaries).toEqual({});
    expect(result.run.gateVerdicts).toEqual([]);
    expect(result.run.verificationRounds).toEqual([]);
    expect(result.run.integrationBranch).toBe("dispatch/test-run");
    expect(result.run.baselineFailures).toEqual([]);
    expect(result.run.baselineBuildLogPath).toBe(
      join(workDir, "dispatch", "test-run", "baseline-build.log"),
    );
    expect(result.run.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/);

    // Branch was created at HEAD.
    const head = await git(workDir, ["rev-parse", "HEAD"]);
    const branchTip = await git(workDir, ["rev-parse", "refs/heads/dispatch/test-run"]);
    expect(branchTip).toBe(head);

    // Baseline log file exists.
    const logRaw = await readFile(result.run.baselineBuildLogPath, "utf8");
    expect(logRaw).toContain("$ echo build-ran");
    expect(logRaw).toContain("build-ran");

    // run-state.yaml exists and round-trips.
    const loaded = await loadRun(result.runStatePath);
    expect(loaded).toEqual(result.run);
  });

  test("skipBaseline=true skips capture and uses empty-string sentinel", async () => {
    const result = await initRun({
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "test-run",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
      skipBaseline: true,
    });

    expect(result.run.baselineBuildLogPath).toBe("");
    expect(result.run.baselineFailures).toEqual([]);

    const loaded = await loadRun(result.runStatePath);
    expect(loaded.baselineBuildLogPath).toBe("");
    expect(loaded.baselineFailures).toEqual([]);
  });

  test("captures failures when the build gate emits them", async () => {
    const failingConfig = `
buildGate:
  - "printf 'src/foo.ts:42:1 - error TS2304: Cannot find name bar\\n' && exit 1"
modelConfig:
  planner: opencode-go/kimi-k2.6
  implementer: opencode-go/kimi-k2.6
  critic: opencode-go/kimi-k2.6
  gateCritic: opencode-go/kimi-k2.6
  greybeard: opencode-go/kimi-k2.6
  attribution: opencode-go/kimi-k2.6
  fixAgent: opencode-go/kimi-k2.6
`;
    await writeFile(join(workDir, "dispatch-config.yaml"), failingConfig, "utf8");
    const result = await initRun({
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "failrun",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    });
    expect(result.run.baselineFailures.length).toBe(1);
    const failure = result.run.baselineFailures[0];
    if (!failure) throw new Error("expected failure");
    expect(failure.file).toBe("src/foo.ts");
    expect(failure.line).toBe(42);
  });

  test("fails on missing dispatch-config", async () => {
    let thrown: unknown = null;
    try {
      await initRun({
        specPath: join(workDir, "spec.md"),
        targetRepoPath: workDir,
        runName: "test-run",
        dispatchConfigPath: join(workDir, "no-such-config.yaml"),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
  });

  test("fails when the integration branch exists at a divergent tip", async () => {
    await git(workDir, ["branch", "dispatch/test-run", "HEAD"]);
    await git(workDir, ["checkout", "-q", "dispatch/test-run"]);
    await writeFile(join(workDir, "extra.txt"), "x\n", "utf8");
    await git(workDir, ["add", "extra.txt"]);
    await git(workDir, ["commit", "-q", "-m", "advance"]);
    await git(workDir, ["checkout", "-q", "main"]);

    let thrown: unknown = null;
    try {
      await initRun({
        specPath: join(workDir, "spec.md"),
        targetRepoPath: workDir,
        runName: "test-run",
        dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("creates the dispatch directory even if it does not exist", async () => {
    const result = await initRun({
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "fresh-run",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    });
    // Just sanity-check that the run was persisted; mkdir is the
    // observable side effect we care about.
    const loaded = await loadRun(result.runStatePath);
    expect(loaded.name).toBe("fresh-run");
  });

  test("respects a pre-existing dispatch directory without clobbering", async () => {
    const runDir = join(workDir, "dispatch", "pre-existing");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "marker.txt"), "kept\n", "utf8");

    const result = await initRun({
      specPath: join(workDir, "spec.md"),
      targetRepoPath: workDir,
      runName: "pre-existing",
      dispatchConfigPath: join(workDir, "dispatch-config.yaml"),
    });
    const marker = await readFile(join(runDir, "marker.txt"), "utf8");
    expect(marker).toBe("kept\n");
    expect(result.run.name).toBe("pre-existing");
  });
});
