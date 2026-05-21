import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitLevel, buildCommitMessage } from "./commit-level.js";
import { loadRun } from "../state/index.js";
import type { Run, Task } from "../state/index.js";

function run(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function initRepo(dir: string): Promise<string> {
  let r = await run(dir, "git", ["init", "--initial-branch=main", "."]);
  expect(r.code).toBe(0);
  r = await run(dir, "git", ["config", "user.email", "test@example.com"]);
  expect(r.code).toBe(0);
  r = await run(dir, "git", ["config", "user.name", "Test User"]);
  expect(r.code).toBe(0);
  r = await run(dir, "git", ["config", "core.hooksPath", ".git/hooks"]);
  expect(r.code).toBe(0);
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  r = await run(dir, "git", ["add", "README.md"]);
  expect(r.code).toBe(0);
  r = await run(dir, "git", ["commit", "-m", "seed"]);
  expect(r.code).toBe(0);
  r = await run(dir, "git", ["rev-parse", "HEAD"]);
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

async function headSHA(dir: string): Promise<string> {
  const r = await run(dir, "git", ["rev-parse", "HEAD"]);
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

function makeTask(args: {
  id: string;
  level: number;
  filesModified: string[];
  worktreePath: string;
  objective?: string;
}): Task {
  return {
    id: args.id,
    level: args.level,
    sequence: "a",
    dependsOn: [],
    objective: args.objective ?? `Add changes for ${args.id}`,
    planMarkdown: "# plan",
    agentType: "intern",
    class: "feature",
    critiqueEnabled: true,
    verifyCommands: [],
    status: "submitted",
    fixingSource: null,
    worktreePath: args.worktreePath,
    output: {
      summary: `summary for ${args.id}`,
      filesModified: args.filesModified,
      deviations: [],
      notes: "",
    },
    commitSHA: null,
    critiqueVerdicts: [],
    amendmentRoundsTotal: 0,
    verificationFixRoundsTotal: 0,
  };
}

function makeRun(args: {
  name: string;
  tasks: Task[];
  levelBoundaries: Record<number, string>;
}): Run {
  return {
    name: args.name,
    specPath: "spec.md",
    targetRepoPath: "/tmp/unused",
    integrationBranch: `dispatch/${args.name}`,
    baselineBuildLogPath: "baseline.log",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "executing",
    tasks: args.tasks,
    levelBoundaries: args.levelBoundaries,
    gateVerdicts: [],
    verificationRounds: [],
    verificationMode: "baseline-equality",
    verificationModeRationale: "",
    createdAt: "2026-05-20T00:00:00Z",
  };
}

let workDir: string;
let repoDir: string;
let statePath: string;
let baseSHA: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "intx-commit-level-"));
  repoDir = join(workDir, "repo");
  await run(workDir, "mkdir", ["-p", "repo"]);
  baseSHA = await initRepo(repoDir);
  statePath = join(workDir, "run-state.yaml");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("commitLevel — single task, single file", () => {
  test("creates one commit, records SHA, sets next boundary", async () => {
    await writeFile(join(repoDir, "feature.ts"), "export const x = 1;\n", "utf8");

    const task = makeTask({
      id: "2a-feature",
      level: 2,
      filesModified: ["feature.ts"],
      worktreePath: repoDir,
    });
    const r = makeRun({
      name: "test-run",
      tasks: [task],
      levelBoundaries: { 2: baseSHA },
    });

    const updated = await commitLevel(r, 2, {
      worktreePath: repoDir,
      statePath,
    });

    const head = await headSHA(repoDir);
    expect(updated.tasks[0]?.status).toEqual("committed");
    expect(updated.tasks[0]?.commitSHA).toEqual(head);
    expect(updated.levelBoundaries[3]).toEqual(head);

    const loaded = await loadRun(statePath);
    expect(loaded.tasks[0]?.commitSHA).toEqual(head);
    expect(loaded.levelBoundaries[3]).toEqual(head);
  });
});

describe("commitLevel — two tasks, no shared files", () => {
  test("creates two commits in lex order, records both SHAs", async () => {
    await writeFile(join(repoDir, "alpha.ts"), "a\n", "utf8");
    await writeFile(join(repoDir, "beta.ts"), "b\n", "utf8");

    const tasks = [
      makeTask({
        id: "2b-beta",
        level: 2,
        filesModified: ["beta.ts"],
        worktreePath: repoDir,
        objective: "Add beta",
      }),
      makeTask({
        id: "2a-alpha",
        level: 2,
        filesModified: ["alpha.ts"],
        worktreePath: repoDir,
        objective: "Add alpha",
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    const updated = await commitLevel(r, 2, {
      worktreePath: repoDir,
      statePath,
    });

    // Walk log: HEAD~1 should be alpha (first lex), HEAD should be beta.
    const log = await run(repoDir, "git", ["log", "--format=%s", "-n", "3"]);
    const subjects = log.stdout.trim().split("\n");
    expect(subjects).toEqual(["Add beta", "Add alpha", "seed"]);

    const alphaTask = updated.tasks.find((t) => t.id === "2a-alpha");
    const betaTask = updated.tasks.find((t) => t.id === "2b-beta");
    expect(alphaTask?.commitSHA).toMatch(/^[0-9a-f]{40}$/);
    expect(betaTask?.commitSHA).toMatch(/^[0-9a-f]{40}$/);
    expect(alphaTask?.commitSHA).not.toEqual(betaTask?.commitSHA);
    expect(updated.levelBoundaries[3]).toEqual(await headSHA(repoDir));
  });
});

describe("commitLevel — shared file goes to later task", () => {
  test("earlier task's commit skips the shared file; later owns it", async () => {
    await writeFile(join(repoDir, "shared.ts"), "shared\n", "utf8");
    await writeFile(join(repoDir, "early.ts"), "early\n", "utf8");
    await writeFile(join(repoDir, "late.ts"), "late\n", "utf8");

    const tasks = [
      makeTask({
        id: "2a-early",
        level: 2,
        filesModified: ["shared.ts", "early.ts"],
        worktreePath: repoDir,
        objective: "Add early changes",
      }),
      makeTask({
        id: "2b-late",
        level: 2,
        filesModified: ["shared.ts", "late.ts"],
        worktreePath: repoDir,
        objective: "Add late changes",
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    const updated = await commitLevel(r, 2, {
      worktreePath: repoDir,
      statePath,
    });

    const earlyTask = updated.tasks.find((t) => t.id === "2a-early");
    const lateTask = updated.tasks.find((t) => t.id === "2b-late");

    // Inspect what each commit touched.
    const earlyFiles = await run(repoDir, "git", [
      "show",
      "--name-only",
      "--format=",
      earlyTask?.commitSHA ?? "",
    ]);
    const lateFiles = await run(repoDir, "git", [
      "show",
      "--name-only",
      "--format=",
      lateTask?.commitSHA ?? "",
    ]);

    expect(earlyFiles.stdout.trim().split("\n").sort()).toEqual(["early.ts"]);
    expect(lateFiles.stdout.trim().split("\n").sort()).toEqual([
      "late.ts",
      "shared.ts",
    ]);
  });
});

describe("commitLevel — zero-file commit unit", () => {
  test("task with no attributed files is marked committed with null SHA, no commit lands", async () => {
    await writeFile(join(repoDir, "shared.ts"), "x\n", "utf8");

    // Both tasks claim only "shared.ts" — the lex-later owns it, the
    // earlier has zero attributed files.
    const tasks = [
      makeTask({
        id: "2a-loser",
        level: 2,
        filesModified: ["shared.ts"],
        worktreePath: repoDir,
        objective: "Loser objective",
      }),
      makeTask({
        id: "2b-winner",
        level: 2,
        filesModified: ["shared.ts"],
        worktreePath: repoDir,
        objective: "Winner objective",
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    const updated = await commitLevel(r, 2, {
      worktreePath: repoDir,
      statePath,
    });

    const loser = updated.tasks.find((t) => t.id === "2a-loser");
    const winner = updated.tasks.find((t) => t.id === "2b-winner");
    expect(loser?.status).toEqual("committed");
    expect(loser?.commitSHA).toBeNull();
    expect(winner?.status).toEqual("committed");
    expect(winner?.commitSHA).toMatch(/^[0-9a-f]{40}$/);

    // Only one commit on top of seed, not two.
    const log = await run(repoDir, "git", ["log", "--format=%H"]);
    const commits = log.stdout.trim().split("\n");
    expect(commits).toHaveLength(2); // seed + winner
    expect(commits[0]).toEqual(winner?.commitSHA ?? "");
  });

  test("an entire level of zero-file commit units leaves the boundary at the prior HEAD", async () => {
    const tasks = [
      makeTask({
        id: "2a",
        level: 2,
        filesModified: [],
        worktreePath: repoDir,
      }),
      makeTask({
        id: "2b",
        level: 2,
        filesModified: [],
        worktreePath: repoDir,
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    const updated = await commitLevel(r, 2, {
      worktreePath: repoDir,
      statePath,
    });

    expect(updated.tasks.every((t) => t.commitSHA === null)).toBe(true);
    expect(updated.tasks.every((t) => t.status === "committed")).toBe(true);
    expect(updated.levelBoundaries[3]).toEqual(baseSHA);
  });
});

describe("commitLevel — boundary write order", () => {
  test("levelBoundaries[level+1] equals HEAD after the last commit lands", async () => {
    await writeFile(join(repoDir, "a.ts"), "a\n", "utf8");
    await writeFile(join(repoDir, "b.ts"), "b\n", "utf8");

    const tasks = [
      makeTask({
        id: "2a",
        level: 2,
        filesModified: ["a.ts"],
        worktreePath: repoDir,
      }),
      makeTask({
        id: "2b",
        level: 2,
        filesModified: ["b.ts"],
        worktreePath: repoDir,
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    const updated = await commitLevel(r, 2, {
      worktreePath: repoDir,
      statePath,
    });

    expect(updated.levelBoundaries[3]).toEqual(await headSHA(repoDir));
    expect(updated.levelBoundaries[2]).toEqual(baseSHA);
  });
});

describe("commitLevel — persistence after each commit", () => {
  test("a mid-level snapshot matches reality (only first commit's SHA recorded after first writeRun)", async () => {
    await writeFile(join(repoDir, "a.ts"), "a\n", "utf8");
    await writeFile(join(repoDir, "b.ts"), "b\n", "utf8");

    // Run the full thing first so we know the final SHAs, then re-run with
    // a hook on the second task that simulates a crash by exiting non-zero
    // *after* the first task has been committed and its state persisted.
    // We can't easily "crash" mid-call, so we verify the per-commit
    // persistence guarantee by hooking commits and reading the state file
    // between them.

    // Strategy: install a pre-commit hook that writes the current
    // run-state.yaml to a snapshot path the first time it runs, so we can
    // verify the state at exactly that point.
    const hooksDir = join(repoDir, ".git", "hooks");
    await run(repoDir, "mkdir", ["-p", hooksDir]);
    // We can't snapshot from inside the hook (state is only written after
    // the commit finishes), so use a different approach: after the call,
    // walk the git log and the final state; then crash-simulate by
    // re-running with a failing second hook.

    const tasks = [
      makeTask({
        id: "2a",
        level: 2,
        filesModified: ["a.ts"],
        worktreePath: repoDir,
      }),
      makeTask({
        id: "2b",
        level: 2,
        filesModified: ["b.ts"],
        worktreePath: repoDir,
        objective: "Add b",
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    // Install a pre-commit hook that fails the SECOND time it runs.
    const counterPath = join(workDir, "hook-counter");
    await writeFile(counterPath, "0", "utf8");
    const hookPath = join(hooksDir, "pre-commit");
    await writeFile(
      hookPath,
      `#!/bin/sh
n=$(cat "${counterPath}")
n=$((n + 1))
echo "$n" > "${counterPath}"
if [ "$n" -ge 2 ]; then
  echo "second-commit-rejected" >&2
  exit 1
fi
exit 0
`,
      "utf8",
    );
    await run(repoDir, "chmod", ["+x", hookPath]);

    let thrown: unknown = null;
    try {
      await commitLevel(r, 2, { worktreePath: repoDir, statePath });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);

    // The on-disk state should reflect: first task committed with a real
    // SHA, second task NOT marked committed (it threw before reaching
    // that write). Crucially, no boundary write for level+1 either,
    // because we never reached the post-loop block.
    const loaded = await loadRun(statePath);
    const firstTask = loaded.tasks.find((t) => t.id === "2a");
    const secondTask = loaded.tasks.find((t) => t.id === "2b");
    expect(firstTask?.status).toEqual("committed");
    expect(firstTask?.commitSHA).toMatch(/^[0-9a-f]{40}$/);
    expect(secondTask?.status).toEqual("submitted"); // unchanged
    expect(secondTask?.commitSHA).toBeNull();
    expect(loaded.levelBoundaries[3]).toBeUndefined();

    // Reality check: git log shows seed + first-task only.
    const log = await run(repoDir, "git", ["log", "--format=%H"]);
    expect(log.stdout.trim().split("\n")).toHaveLength(2);
  });
});

describe("commitLevel — worktree path resolution", () => {
  test("derives worktree path from tasks' worktreePath when override absent", async () => {
    await writeFile(join(repoDir, "x.ts"), "x\n", "utf8");
    const tasks = [
      makeTask({
        id: "2a",
        level: 2,
        filesModified: ["x.ts"],
        worktreePath: repoDir,
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    const updated = await commitLevel(r, 2, { statePath });
    expect(updated.tasks[0]?.commitSHA).toMatch(/^[0-9a-f]{40}$/);
  });

  test("rejects mixed worktreePath values across tasks at the same level", async () => {
    const tasks = [
      makeTask({
        id: "2a",
        level: 2,
        filesModified: [],
        worktreePath: repoDir,
      }),
      makeTask({
        id: "2b",
        level: 2,
        filesModified: [],
        worktreePath: "/different/path",
      }),
    ];
    const r = makeRun({
      name: "test-run",
      tasks,
      levelBoundaries: { 2: baseSHA },
    });

    let thrown: unknown = null;
    try {
      await commitLevel(r, 2, { statePath });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toMatch(/share one worktreePath/);
  });
});

describe("commitLevel — preconditions", () => {
  test("throws when no tasks exist at the requested level", async () => {
    const r = makeRun({
      name: "test-run",
      tasks: [],
      levelBoundaries: { 2: baseSHA },
    });
    let thrown: unknown = null;
    try {
      await commitLevel(r, 2, { worktreePath: repoDir, statePath });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("buildCommitMessage", () => {
  function t(id: string, objective: string): Task {
    return makeTask({
      id,
      level: 2,
      filesModified: [],
      worktreePath: repoDir,
      objective,
    });
  }

  test("uses the full objective when it fits in 72 chars", () => {
    const msg = buildCommitMessage(t("x", "Add retry logic for failed network requests"));
    expect(msg).toEqual("Add retry logic for failed network requests");
  });

  test("strips trailing punctuation from the summary", () => {
    const msg = buildCommitMessage(t("x", "Add retry logic."));
    expect(msg).toEqual("Add retry logic");
  });

  test("truncates summaries longer than 72 chars at the last word boundary", () => {
    const objective =
      "Add retry logic for failed network requests with exponential backoff and jitter to avoid thundering herds";
    const msg = buildCommitMessage(t("x", objective));
    expect(msg.length).toBeLessThanOrEqual(72);
    expect(msg.endsWith(" ")).toBe(false);
    // Must end at a word boundary, not mid-word.
    expect(/[A-Za-z]$/.test(msg)).toBe(true);
  });

  test("multi-sentence objective: first sentence becomes summary, rest becomes body", () => {
    const objective =
      "Add retry logic for failed network requests. The retry uses exponential backoff with jitter.";
    const msg = buildCommitMessage(t("x", objective));
    const lines = msg.split("\n");
    expect(lines[0]).toEqual("Add retry logic for failed network requests");
    expect(lines[1]).toEqual("");
    expect(lines.slice(2).join("\n")).toEqual(
      "The retry uses exponential backoff with jitter.",
    );
  });

  test("throws on an empty objective", () => {
    expect(() => buildCommitMessage(t("x", "   "))).toThrow(/empty objective/);
  });
});
