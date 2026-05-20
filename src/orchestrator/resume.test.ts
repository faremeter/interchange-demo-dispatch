import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeRun, loadRun } from "../state/index.js";
import type { Run, Task } from "../state/index.js";

import { pathExists, ResumeAmbiguousError, RESUME_AMBIGUOUS, resume, resumeWithOptions } from "./resume.js";
import type { GitExecutor, GitExecutorResult } from "./worktree.js";

function execGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", rejectFn);
    child.on("close", (code) => {
      resolveFn({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function initFixtureRepo(dir: string): Promise<string> {
  let r = await execGit(dir, ["init", "--initial-branch=main", "."]);
  expect(r.code).toBe(0);
  r = await execGit(dir, ["config", "user.email", "test@example.com"]);
  expect(r.code).toBe(0);
  r = await execGit(dir, ["config", "user.name", "Test User"]);
  expect(r.code).toBe(0);
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  r = await execGit(dir, ["add", "README.md"]);
  expect(r.code).toBe(0);
  r = await execGit(dir, ["commit", "-m", "seed"]);
  expect(r.code).toBe(0);
  r = await execGit(dir, ["rev-parse", "HEAD"]);
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

async function commitFile(
  dir: string,
  path: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(dir, path), contents, "utf8");
  let r = await execGit(dir, ["add", path]);
  expect(r.code).toBe(0);
  r = await execGit(dir, ["commit", "-m", message]);
  expect(r.code).toBe(0);
  r = await execGit(dir, ["rev-parse", "HEAD"]);
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

const realGitExecutor: GitExecutor = async ({ args, cwd }) => {
  const r = await execGit(cwd, args);
  const result: GitExecutorResult = {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.code,
  };
  return result;
};

function makeTask(over: Partial<Task> & { id: string; level: number }): Task {
  const base: Task = {
    id: over.id,
    level: over.level,
    sequence: "a",
    dependsOn: [],
    objective: `Objective for ${over.id}`,
    planMarkdown: "# plan",
    agentType: "general",
    class: "feature",
    critiqueEnabled: true,
    verifyCommands: [],
    status: "pending",
    fixingSource: null,
    worktreePath: null,
    output: null,
    commitSHA: null,
    critiqueVerdicts: [],
    amendmentRoundsTotal: 0,
    verificationFixRoundsTotal: 0,
  };
  return { ...base, ...over };
}

function makeRun(over: Partial<Run> & { name: string; tasks: Task[] }): Run {
  const base: Run = {
    name: over.name,
    specPath: "spec.md",
    targetRepoPath: "/tmp/unused",
    integrationBranch: `dispatch/${over.name}`,
    baselineBuildLogPath: "baseline.log",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "executing",
    tasks: over.tasks,
    levelBoundaries: {},
    gateVerdicts: [],
    verificationRounds: [],
    createdAt: "2026-05-20T00:00:00Z",
  };
  return { ...base, ...over };
}

let workDir: string;
let runDir: string;
let runStatePath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "intx-resume-"));
  runDir = join(workDir, "dispatch", "test-run");
  await mkdir(runDir, { recursive: true });
  runStatePath = join(runDir, "run-state.yaml");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("resume — terminal states", () => {
  test("status=done is returned unchanged", async () => {
    const r = makeRun({ name: "test-run", tasks: [], status: "done" });
    await writeRun(runStatePath, r);
    const after = await resume(runDir);
    expect(after.status).toBe("done");
    expect(after.name).toBe("test-run");
  });

  test("status=failed is returned unchanged", async () => {
    const r = makeRun({ name: "test-run", tasks: [], status: "failed" });
    await writeRun(runStatePath, r);
    const after = await resume(runDir);
    expect(after.status).toBe("failed");
  });
});

describe("resume — case 1: mid-task implementer", () => {
  test("kills agent-ctx and resets running task to pending", async () => {
    const task = makeTask({
      id: "1a-impl",
      level: 1,
      status: "running",
      worktreePath: join(runDir, "worktrees", "level-1"),
    });
    const r = makeRun({ name: "test-run", tasks: [task] });
    await writeRun(runStatePath, r);

    const ctxDir = join(runDir, "tasks", task.id, "agent-ctx");
    await mkdir(ctxDir, { recursive: true });
    await writeFile(join(ctxDir, "scratch.txt"), "stale", "utf8");

    const after = await resume(runDir);

    expect(await pathExists(ctxDir)).toBe(false);
    expect(after.tasks[0]?.status).toBe("pending");

    const persisted = await loadRun(runStatePath);
    expect(persisted.tasks[0]?.status).toBe("pending");
  });
});

describe("resume — case 2: submitOutput race", () => {
  test("deletes orphan output.yaml + agent-ctx and resets running task", async () => {
    const task = makeTask({
      id: "1b-impl",
      level: 1,
      status: "running",
      worktreePath: join(runDir, "worktrees", "level-1"),
    });
    const r = makeRun({ name: "test-run", tasks: [task] });
    await writeRun(runStatePath, r);

    const taskDir = join(runDir, "tasks", task.id);
    const ctxDir = join(taskDir, "agent-ctx");
    const outputPath = join(taskDir, "output.yaml");
    await mkdir(ctxDir, { recursive: true });
    await writeFile(outputPath, "summary: stale\n", "utf8");

    const after = await resume(runDir);

    expect(await pathExists(ctxDir)).toBe(false);
    expect(await pathExists(outputPath)).toBe(false);
    expect(after.tasks[0]?.status).toBe("pending");
  });
});

describe("resume — case 3: fix-agent crashed with uncommitted changes", () => {
  test("reverts worktree to commitSHA and leaves task in fixing", async () => {
    const repoDir = join(workDir, "repo");
    await mkdir(repoDir, { recursive: true });
    const seed = await initFixtureRepo(repoDir);
    const sha1 = await commitFile(repoDir, "alpha.ts", "1\n", "alpha");

    // Dirty the worktree as if the fix agent edited it.
    await writeFile(join(repoDir, "alpha.ts"), "DIRTY\n", "utf8");
    await writeFile(join(repoDir, "stray.txt"), "stray\n", "utf8");

    const task = makeTask({
      id: "1c-fix",
      level: 1,
      status: "fixing",
      fixingSource: "critique",
      worktreePath: repoDir,
      commitSHA: sha1,
    });
    const r = makeRun({
      name: "test-run",
      tasks: [task],
      levelBoundaries: { 1: seed },
    });
    await writeRun(runStatePath, r);

    const after = await resumeWithOptions(runDir, { gitExecutor: realGitExecutor });

    const statusAfter = await execGit(repoDir, ["status", "--porcelain"]);
    expect(statusAfter.stdout.trim()).toBe("");
    const headAfter = await execGit(repoDir, ["rev-parse", "HEAD"]);
    expect(headAfter.stdout.trim()).toBe(sha1);

    expect(after.tasks[0]?.status).toBe("fixing");
    expect(after.tasks[0]?.fixingSource).toBe("critique");
  });
});

describe("resume — case 4: mid-rebuild between commits", () => {
  test("resets stale tasks back to submitted from first missing SHA", async () => {
    const repoDir = join(workDir, "repo");
    await mkdir(repoDir, { recursive: true });
    const seed = await initFixtureRepo(repoDir);
    // Level 1 fully committed: two tasks, two real commits.
    const shaAlpha = await commitFile(repoDir, "alpha.ts", "1\n", "alpha");
    const shaBeta = await commitFile(repoDir, "beta.ts", "1\n", "beta");

    // State claims THREE tasks committed at level 1, but only two
    // commits exist on disk. The third's SHA is fake (not reachable
    // from HEAD). This simulates a crash mid-rebuild: the orchestrator
    // wrote `commitSHA` for the third task before the commit actually
    // landed.
    const tasks = [
      makeTask({
        id: "1a-alpha",
        level: 1,
        status: "committed",
        worktreePath: repoDir,
        commitSHA: shaAlpha,
      }),
      makeTask({
        id: "1b-beta",
        level: 1,
        status: "committed",
        worktreePath: repoDir,
        commitSHA: shaBeta,
      }),
      makeTask({
        id: "1c-gamma",
        level: 1,
        status: "committed",
        worktreePath: repoDir,
        commitSHA: "0".repeat(40),
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 1: seed },
    });
    await writeRun(runStatePath, r);

    const after = await resumeWithOptions(runDir, { gitExecutor: realGitExecutor });

    const byId = new Map(after.tasks.map((t) => [t.id, t]));
    expect(byId.get("1a-alpha")?.status).toBe("committed");
    expect(byId.get("1a-alpha")?.commitSHA).toBe(shaAlpha);
    expect(byId.get("1b-beta")?.status).toBe("committed");
    expect(byId.get("1b-beta")?.commitSHA).toBe(shaBeta);
    // Third task: cleared back to `submitted`, commitSHA wiped.
    expect(byId.get("1c-gamma")?.status).toBe("submitted");
    expect(byId.get("1c-gamma")?.commitSHA).toBeNull();
  });
});

describe("resume — case 5: between commit and boundary write", () => {
  test("recomputes missing levelBoundaries from worktree HEAD", async () => {
    const repoDir = join(workDir, "repo");
    await mkdir(repoDir, { recursive: true });
    const seed = await initFixtureRepo(repoDir);
    const shaA = await commitFile(repoDir, "alpha.ts", "1\n", "alpha");
    const shaB = await commitFile(repoDir, "beta.ts", "1\n", "beta");

    const tasks = [
      makeTask({
        id: "1a-alpha",
        level: 1,
        status: "committed",
        worktreePath: repoDir,
        commitSHA: shaA,
      }),
      makeTask({
        id: "1b-beta",
        level: 1,
        status: "committed",
        worktreePath: repoDir,
        commitSHA: shaB,
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      // Pre-level boundary set, post-level boundary missing.
      levelBoundaries: { 1: seed },
    });
    await writeRun(runStatePath, r);

    const after = await resumeWithOptions(runDir, { gitExecutor: realGitExecutor });

    expect(after.levelBoundaries[2]).toBe(shaB);
    const persisted = await loadRun(runStatePath);
    expect(persisted.levelBoundaries[2]).toBe(shaB);
  });
});

describe("resume — case 6: baseline captured, planning not started", () => {
  test("returns unchanged when status=planning and tasks empty", async () => {
    const r = makeRun({ name: "test-run", tasks: [], status: "planning" });
    await writeRun(runStatePath, r);

    const after = await resume(runDir);

    expect(after.status).toBe("planning");
    expect(after.tasks).toEqual([]);
  });
});

describe("resume — case 7: orphan final-build log", () => {
  test("deletes orphan final-build.log for round with no entry", async () => {
    const task = makeTask({
      id: "1a-impl",
      level: 1,
      status: "completed",
      worktreePath: join(runDir, "worktrees", "level-1"),
      commitSHA: "a".repeat(40),
      output: {
        summary: "done",
        filesModified: ["alpha.ts"],
        deviations: [],
        notes: "",
      },
    });
    const r = makeRun({
      name: "test-run",
      tasks: [task],
      status: "fixing-verification",
      // Post-level boundary already on record so case 5 doesn't fire
      // off the back of a `completed` task that has no live worktree.
      levelBoundaries: { 2: "b".repeat(40) },
      verificationRounds: [
        {
          round: 1,
          finalBuildLogPath: join(runDir, "final-build.log-1"),
          newFailures: [],
          attribution: {},
          rebuildFromLevel: null,
          outcome: "retry",
        },
      ],
    });
    await writeRun(runStatePath, r);

    await writeFile(join(runDir, "final-build.log-1"), "round1\n", "utf8");
    await writeFile(join(runDir, "final-build.log-2"), "orphan\n", "utf8");

    const after = await resume(runDir);

    expect(await pathExists(join(runDir, "final-build.log-1"))).toBe(true);
    expect(await pathExists(join(runDir, "final-build.log-2"))).toBe(false);
    expect(after.verificationRounds.length).toBe(1);
  });
});

describe("resume — ambiguous state", () => {
  test("non-terminal state matching no case throws RESUME_AMBIGUOUS", async () => {
    // status=executing, every task at status=completed, no orphan logs,
    // boundaries already consistent (no commitSHAs, no worktrees, no
    // committed tasks). Nothing on disk matches any of the seven cases.
    const task = makeTask({
      id: "1a-done",
      level: 1,
      status: "completed",
      output: {
        summary: "done",
        filesModified: [],
        deviations: [],
        notes: "",
      },
    });
    const r = makeRun({ name: "test-run", tasks: [task], status: "executing" });
    await writeRun(runStatePath, r);

    let caught: unknown = null;
    try {
      await resume(runDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResumeAmbiguousError);
    if (!(caught instanceof ResumeAmbiguousError)) return;
    expect(caught.code).toBe(RESUME_AMBIGUOUS);
    expect(caught.evidence.runName).toBe("test-run");
    expect(caught.evidence.runStatus).toBe("executing");
    expect(caught.evidence.matchedCases).toEqual([]);
  });
});

describe("resume — composition", () => {
  test("applies multiple orthogonal cases in one pass", async () => {
    const repoDir = join(workDir, "repo");
    await mkdir(repoDir, { recursive: true });
    const seed = await initFixtureRepo(repoDir);
    const shaA = await commitFile(repoDir, "alpha.ts", "1\n", "alpha");

    // Two interruptions at once:
    //   - Task `1a-impl` is running with agent-ctx (case 1).
    //   - Run has an orphan final-build.log-1 with no rounds (case 7).
    const taskRunning = makeTask({
      id: "1a-impl",
      level: 1,
      status: "running",
      worktreePath: repoDir,
    });
    const taskCommitted = makeTask({
      id: "1b-other",
      level: 1,
      status: "committed",
      worktreePath: repoDir,
      commitSHA: shaA,
    });
    const r = makeRun({
      name: "test-run",
      tasks: [taskRunning, taskCommitted],
      status: "executing",
      levelBoundaries: { 1: seed, 2: shaA },
    });
    await writeRun(runStatePath, r);

    const ctxDir = join(runDir, "tasks", taskRunning.id, "agent-ctx");
    await mkdir(ctxDir, { recursive: true });
    await writeFile(join(runDir, "final-build.log-1"), "orphan\n", "utf8");

    const after = await resumeWithOptions(runDir, { gitExecutor: realGitExecutor });

    expect(await pathExists(ctxDir)).toBe(false);
    expect(await pathExists(join(runDir, "final-build.log-1"))).toBe(false);
    const byId = new Map(after.tasks.map((t) => [t.id, t]));
    expect(byId.get(taskRunning.id)?.status).toBe("pending");
    expect(byId.get(taskCommitted.id)?.status).toBe("committed");
  });
});
