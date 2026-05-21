import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consolidate } from "./consolidate.js";
import { loadRun } from "../state/index.js";
import type { Run } from "../state/index.js";

function runCmd(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

async function gitInit(repoRoot: string): Promise<string> {
  await runCmd(repoRoot, "git", ["init", "--initial-branch=main", "."]);
  await runCmd(repoRoot, "git", ["config", "user.email", "test@example"]);
  await runCmd(repoRoot, "git", ["config", "user.name", "Test"]);
  await writeFile(join(repoRoot, "README"), "init\n");
  await runCmd(repoRoot, "git", ["add", "README"]);
  await runCmd(repoRoot, "git", ["commit", "-m", "initial"]);
  const head = await runCmd(repoRoot, "git", ["rev-parse", "HEAD"]);
  return head.stdout.trim();
}

async function gitCommitOn(
  repoRoot: string,
  branch: string,
  from: string,
  filename: string,
  body: string,
): Promise<string> {
  await runCmd(repoRoot, "git", ["update-ref", `refs/heads/${branch}`, from]);
  await runCmd(repoRoot, "git", ["checkout", branch]);
  await writeFile(join(repoRoot, filename), body);
  await runCmd(repoRoot, "git", ["add", filename]);
  await runCmd(repoRoot, "git", ["commit", "-m", `add ${filename} on ${branch}`]);
  const head = await runCmd(repoRoot, "git", ["rev-parse", "HEAD"]);
  return head.stdout.trim();
}

function emptyRun(overrides: Partial<Run> & Pick<Run, "name" | "tasks">): Run {
  return {
    name: overrides.name,
    specPath: "/tmp/spec.md",
    targetRepoPath: "/tmp/target",
    integrationBranch: `dispatch/${overrides.name}`,
    baselineBuildLogPath: "",
    baselineFailures: [],
    commitStrategy: "per-task",
    status: "consolidating",
    tasks: overrides.tasks,
    levelBoundaries: {},
    gateVerdicts: [],
    verificationRounds: [],
    verificationMode: "baseline-equality",
    verificationModeRationale: "",
    createdAt: "2026-05-21T00:00:00Z",
  };
}

describe("consolidate", () => {
  let repoRoot: string;
  let runStatePath: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "consolidate-test-"));
    await gitInit(repoRoot);
    runStatePath = join(repoRoot, "run-state.yaml");
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("fast-forwards integration branch to last-level tip", async () => {
    const baseRef = (await runCmd(repoRoot, "git", ["rev-parse", "main"])).stdout.trim();

    // Create per-level branches stacked off main.
    const level1Tip = await gitCommitOn(repoRoot, "dispatch/r-level-1", baseRef, "a.txt", "1\n");
    const level2Tip = await gitCommitOn(repoRoot, "dispatch/r-level-2", level1Tip, "b.txt", "2\n");

    // The integration branch starts at main (where initRun would have left it).
    await runCmd(repoRoot, "git", ["update-ref", "refs/heads/dispatch/r", baseRef]);

    const run = emptyRun({
      name: "r",
      tasks: [
        // The shape of Task we need is "has level + status"; consolidate only reads `level`.
        {
          id: "1a-foo",
          level: 1,
          sequence: "a",
          dependsOn: [],
          objective: "first",
          planMarkdown: "x".repeat(200),
          agentType: "intern",
          class: "feature",
          critiqueEnabled: false,
          verifyCommands: [],
          status: "completed",
          fixingSource: null,
          worktreePath: null,
          output: null,
          commitSHA: level1Tip,
          critiqueVerdicts: [],
          amendmentRoundsTotal: 0,
          verificationFixRoundsTotal: 0,
        },
        {
          id: "2a-bar",
          level: 2,
          sequence: "a",
          dependsOn: ["1a-foo"],
          objective: "second",
          planMarkdown: "x".repeat(200),
          agentType: "intern",
          class: "feature",
          critiqueEnabled: false,
          verifyCommands: [],
          status: "completed",
          fixingSource: null,
          worktreePath: null,
          output: null,
          commitSHA: level2Tip,
          critiqueVerdicts: [],
          amendmentRoundsTotal: 0,
          verificationFixRoundsTotal: 0,
        },
      ],
    });

    const result = await consolidate(run, { repoRoot, runStatePath });

    expect(result.status).toBe("done");

    const integrationTip = (
      await runCmd(repoRoot, "git", ["rev-parse", "refs/heads/dispatch/r"])
    ).stdout.trim();
    expect(integrationTip).toBe(level2Tip);

    const persisted = await loadRun(runStatePath);
    expect(persisted.status).toBe("done");
  });

  test("is idempotent when already at the last-level tip", async () => {
    const baseRef = (await runCmd(repoRoot, "git", ["rev-parse", "main"])).stdout.trim();
    const level1Tip = await gitCommitOn(repoRoot, "dispatch/r-level-1", baseRef, "a.txt", "1\n");

    // Pre-position integration branch at level-1's tip.
    await runCmd(repoRoot, "git", ["update-ref", "refs/heads/dispatch/r", level1Tip]);

    const run = emptyRun({
      name: "r",
      tasks: [
        {
          id: "1a-foo",
          level: 1,
          sequence: "a",
          dependsOn: [],
          objective: "first",
          planMarkdown: "x".repeat(200),
          agentType: "intern",
          class: "feature",
          critiqueEnabled: false,
          verifyCommands: [],
          status: "completed",
          fixingSource: null,
          worktreePath: null,
          output: null,
          commitSHA: level1Tip,
          critiqueVerdicts: [],
          amendmentRoundsTotal: 0,
          verificationFixRoundsTotal: 0,
        },
      ],
    });

    const result = await consolidate(run, { repoRoot, runStatePath });
    expect(result.status).toBe("done");

    const integrationTip = (
      await runCmd(repoRoot, "git", ["rev-parse", "refs/heads/dispatch/r"])
    ).stdout.trim();
    expect(integrationTip).toBe(level1Tip);
  });

  test("refuses non-fast-forward (integration tip is not an ancestor of last-level tip)", async () => {
    const baseRef = (await runCmd(repoRoot, "git", ["rev-parse", "main"])).stdout.trim();
    const level1Tip = await gitCommitOn(repoRoot, "dispatch/r-level-1", baseRef, "a.txt", "1\n");
    // Make the integration branch advance independently — a fake "concurrent push" scenario.
    const integrationAhead = await gitCommitOn(
      repoRoot,
      "dispatch/r",
      baseRef,
      "intgrn.txt",
      "advanced\n",
    );
    expect(integrationAhead).not.toBe(level1Tip);

    const run = emptyRun({
      name: "r",
      tasks: [
        {
          id: "1a-foo",
          level: 1,
          sequence: "a",
          dependsOn: [],
          objective: "first",
          planMarkdown: "x".repeat(200),
          agentType: "intern",
          class: "feature",
          critiqueEnabled: false,
          verifyCommands: [],
          status: "completed",
          fixingSource: null,
          worktreePath: null,
          output: null,
          commitSHA: level1Tip,
          critiqueVerdicts: [],
          amendmentRoundsTotal: 0,
          verificationFixRoundsTotal: 0,
        },
      ],
    });

    await expect(
      consolidate(run, { repoRoot, runStatePath }),
    ).rejects.toThrow(/not an ancestor/);

    // Integration branch is untouched.
    const integrationTip = (
      await runCmd(repoRoot, "git", ["rev-parse", "refs/heads/dispatch/r"])
    ).stdout.trim();
    expect(integrationTip).toBe(integrationAhead);
  });
});
