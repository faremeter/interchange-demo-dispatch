// CLI integration tests.
//
// Spawn the compiled CLI as a child process against a fixture git
// repo. The fixture writes a small `scripts.mjs` module that exports
// the orchestrator overrides; `--scripts` loads it so the CLI can
// drive a real end-to-end run without contacting any model provider.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRun } from "./state/index.js";

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runChild(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
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
    child.on("close", (code) =>
      resolveResult({
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const r = await runChild("git", args, cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

const VALID_CONFIG = `
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

// Run the CLI under bun against the source-level entry. When
// `import.meta.dir` is the `src/` tree the .ts entrypoint exists;
// when bun is loading a `.test.js` copy out of `dist/` the .js
// emit is the right one. Pick whichever entry the filesystem
// actually has so the test works under either layout.
const CLI_PATH = (() => {
  const candidates = [
    join(import.meta.dir, "cli.ts"),
    join(import.meta.dir, "cli.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`no cli entrypoint found at ${candidates.join(" or ")}`);
})();

let workDir: string;

async function setupFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intx-cli-"));
  await gitOrThrow(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "# test\n", "utf8");
  await gitOrThrow(dir, ["add", "README.md"]);
  await gitOrThrow(dir, ["commit", "-q", "-m", "initial"]);
  await writeFile(join(dir, "spec.md"), "# spec\n\nDo things.\n", "utf8");
  await writeFile(join(dir, "dispatch-config.yaml"), VALID_CONFIG, "utf8");
  await mkdir(join(dir, "skills"), { recursive: true });
  return dir;
}

beforeEach(async () => {
  workDir = await setupFixture();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const SCRIPTS_CONTENT = `
const longBody = "## Objective\\nWrite a small fixture file owned by alpha at level 1.\\n\\n## Approach\\nUse the implementer's write_file tool to put a short text body at the declared path.\\nSubmit with the declared file in filesModified and no deviations.\\n\\n## Verification\\nPass-through verification; the test asserts the commit lands and the report is rendered.\\n\\n## Notes\\nThis plan body is verbose only to satisfy the planner's 200-character minimum.\\n";

function scriptedDirector(steps) {
  let cursor = 0;
  const advance = (caps) => {
    if (cursor >= steps.length) return caps.done();
    const step = steps[cursor++];
    if (step === undefined) return caps.done();
    if (step.type === "executeTools") return caps.executeTools(step.calls);
    return caps.done();
  };
  return {
    async decide(event, _state, caps) {
      switch (event.type) {
        case "message.received":
        case "tool.done":
          return advance(caps);
        default:
          return caps.done();
      }
    },
  };
}

const scriptForAlpha = [
  {
    type: "executeTools",
    calls: [{ id: "w-alpha", name: "write_file", arguments: { path: "alpha.txt", content: "alpha-body\\n" } }],
  },
  {
    type: "executeTools",
    calls: [{ id: "s-alpha", name: "submitOutput", arguments: { summary: "wrote alpha.txt", filesModified: ["alpha.txt"], deviations: [], notes: "" } }],
  },
];

export const plannerOverride = async () => ({
  tasks: [
    {
      idHint: "alpha",
      id: "alpha",
      level: 1,
      dependsOn: [],
      objective: "Write a fixture file owned by alpha",
      planMarkdown: longBody,
      agentType: "general",
      class: "feature",
      verifyCommands: [],
      critiqueEnabled: true,
    },
  ],
  levels: { alpha: 1 },
});

export const directorFactory = () => scriptedDirector(scriptForAlpha);

export const criticRunner = async ({ round }) => ({ round, status: "pass", findings: [], newTests: [] });
export const gateCriticRunner = async ({ level, round, perTaskVerdicts }) => {
  const perTask = {};
  for (const { taskId } of perTaskVerdicts) perTask[taskId] = { status: "pass", findings: [] };
  return { level, round, status: "pass", perTask };
};
export const fixAgentRunner = async () => { throw new Error("fix agent should not run"); };
export const phase5FixAgentRunner = async () => { throw new Error("phase5 fix should not run"); };
export const attributionRunner = async () => { throw new Error("attribution should not run"); };
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export const buildGateRunner = async ({ run }) => {
  const baselinePath = join(process.cwd(), "dispatch", run.name, "baseline-build.log");
  const output = await readFile(baselinePath, "utf8");
  return { output, exitCode: 0 };
};
export const taskVerifier = async () => ({ ok: true, output: "" });
`;

describe("interchange-demo-dispatch CLI", () => {
  test("happy path: exit 0, report path printed, run-state status done", async () => {
    await writeFile(join(workDir, "scripts.mjs"), SCRIPTS_CONTENT, "utf8");

    const result = await runChild(
      "bun",
      [CLI_PATH, "cli-run", "--scripts", "scripts.mjs"],
      workDir,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `cli exited ${String(result.exitCode)}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      );
    }
    expect(result.exitCode).toBe(0);
    const printed = result.stdout.trim();
    expect(printed).toMatch(/\/dispatch\/cli-run\/report\.md$/);

    const reportBody = await readFile(printed, "utf8");
    expect(reportBody).toContain("# Dispatch report: cli-run");

    const run = await loadRun(join(workDir, "dispatch", "cli-run", "run-state.yaml"));
    expect(run.status).toBe("done");
  });

  test("--skip-baseline path records empty baselineBuildLogPath and exits 0", async () => {
    await writeFile(join(workDir, "scripts.mjs"), SCRIPTS_CONTENT, "utf8");

    const result = await runChild(
      "bun",
      [CLI_PATH, "skip-baseline-cli", "--skip-baseline", "--scripts", "scripts.mjs"],
      workDir,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `cli exited ${String(result.exitCode)}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      );
    }
    expect(result.exitCode).toBe(0);
    const run = await loadRun(
      join(workDir, "dispatch", "skip-baseline-cli", "run-state.yaml"),
    );
    expect(run.baselineBuildLogPath).toBe("");
    expect(run.status).toBe("done");
  });

  test("teardown verb removes the worktrees but leaves the report and state", async () => {
    await writeFile(join(workDir, "scripts.mjs"), SCRIPTS_CONTENT, "utf8");

    const runResult = await runChild(
      "bun",
      [CLI_PATH, "teardown-fixture", "--scripts", "scripts.mjs"],
      workDir,
    );
    expect(runResult.exitCode).toBe(0);

    const worktree = join(
      workDir,
      "dispatch",
      "teardown-fixture",
      "worktrees",
      "level-1",
    );
    // Worktree must exist before teardown.
    expect((await readFile(join(worktree, "alpha.txt"), "utf8")).trim()).toBe(
      "alpha-body",
    );

    const teardown = await runChild(
      "bun",
      [CLI_PATH, "teardown", "teardown-fixture"],
      workDir,
    );
    if (teardown.exitCode !== 0) {
      throw new Error(`teardown exited ${String(teardown.exitCode)}: ${teardown.stderr}`);
    }
    expect(teardown.exitCode).toBe(0);

    let stillExists = false;
    try {
      await readFile(join(worktree, "alpha.txt"), "utf8");
      stillExists = true;
    } catch {
      stillExists = false;
    }
    expect(stillExists).toBe(false);

    // Report and run-state.yaml survive.
    const report = await readFile(
      join(workDir, "dispatch", "teardown-fixture", "report.md"),
      "utf8",
    );
    expect(report.length).toBeGreaterThan(0);
  });

  test("rejects a config with commitStrategy != per-task at load", async () => {
    await writeFile(
      join(workDir, "dispatch-config.yaml"),
      `${VALID_CONFIG}commitStrategy: grouped\n`,
      "utf8",
    );
    const result = await runChild("bun", [CLI_PATH, "locked-cli"], workDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("locked to \"per-task\"");
  });
});
