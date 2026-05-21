import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRun, loadRun } from "./persist.js";
import type { Run } from "./types.js";

const sampleRun: Run = {
  name: "interchange-demo-dispatch-poc",
  specPath: "spec.md",
  targetRepoPath: "/path/to/repo",
  integrationBranch: "dispatch/interchange-demo-dispatch-poc",
  baselineBuildLogPath: "dispatch/interchange-demo-dispatch-poc/baseline-build.log",
  baselineFailures: [
    {
      id: "bf-1",
      file: "src/foo.ts",
      line: 42,
      message: "TS2304",
      rawText: "src/foo.ts:42:1 - error TS2304: Cannot find name 'bar'",
    },
  ],
  commitStrategy: "per-task",
  status: "planning",
  tasks: [
    {
      id: "2a-state-model",
      level: 2,
      sequence: "a",
      dependsOn: ["1a-bootstrap"],
      objective: "build the state model",
      planMarkdown: "# plan\n\nDo the thing.",
      agentType: "intern",
      class: "feature",
      critiqueEnabled: true,
      verifyCommands: ["bun test"],
      status: "pending",
      fixingSource: null,
      worktreePath: null,
      output: null,
      commitSHA: null,
      critiqueVerdicts: [],
      amendmentRoundsTotal: 0,
      verificationFixRoundsTotal: 0,
    },
  ],
  levelBoundaries: { "0": "deadbeef", "1": "cafebabe" },
  gateVerdicts: [],
  verificationRounds: [],
  verificationMode: "baseline-equality",
  verificationModeRationale: "",
  createdAt: "2026-05-20T00:00:00Z",
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "intx-state-persist-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("writeRun + loadRun round-trip", () => {
  test("writes, reads, and validates a Run deep-equal to the input", async () => {
    const path = join(workDir, "run-state.yaml");
    await writeRun(path, sampleRun);
    const loaded = await loadRun(path);
    expect(loaded).toEqual(sampleRun);
  });

  test("produces a human-inspectable YAML file (not JSON)", async () => {
    const path = join(workDir, "run-state.yaml");
    await writeRun(path, sampleRun);
    const raw = await readFile(path, "utf8");
    expect(raw.startsWith("{")).toBe(false);
    expect(raw).toContain("name: interchange-demo-dispatch-poc");
    expect(raw).toContain("commitStrategy: per-task");
  });
});

describe("atomic write semantics", () => {
  test("leaves no tmp file behind on success", async () => {
    const path = join(workDir, "run-state.yaml");
    await writeRun(path, sampleRun);
    const entries = await readdir(workDir);
    const tmps = entries.filter((e) => e.includes(".tmp-"));
    expect(tmps).toEqual([]);
    expect(entries).toContain("run-state.yaml");
  });

  test("a pre-existing file is preserved when a tmp file exists but the rename did not happen", async () => {
    const path = join(workDir, "run-state.yaml");
    await writeRun(path, sampleRun);
    const originalRaw = await readFile(path, "utf8");

    const tmpPath = `${path}.tmp-${process.pid}-simulated-crash`;
    await writeFile(tmpPath, "partial: write\n", "utf8");

    const stillThere = await readFile(path, "utf8");
    expect(stillThere).toEqual(originalRaw);

    const reloaded = await loadRun(path);
    expect(reloaded).toEqual(sampleRun);
  });

  test("writeRun on the same path replaces the file atomically", async () => {
    const path = join(workDir, "run-state.yaml");
    await writeRun(path, sampleRun);

    const mutated: Run = { ...sampleRun, status: "executing" };
    await writeRun(path, mutated);

    const loaded = await loadRun(path);
    expect(loaded.status).toEqual("executing");
    expect(loaded).toEqual(mutated);
  });
});

describe("loadRun validation errors", () => {
  test("throws on a malformed Run with cause attached", async () => {
    const path = join(workDir, "run-state.yaml");
    await writeFile(
      path,
      "name: bad\nstatus: not-a-real-status\n",
      "utf8",
    );

    let thrown: unknown = null;
    try {
      await loadRun(path);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toContain("invalid run-state YAML");
    expect(thrown.cause).toBeDefined();
  });

  test("throws on a non-existent path", async () => {
    let thrown: unknown = null;
    try {
      await loadRun(join(workDir, "missing.yaml"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
  });

  test("throws on an empty file", async () => {
    const path = join(workDir, "empty.yaml");
    await writeFile(path, "", "utf8");

    let thrown: unknown = null;
    try {
      await loadRun(path);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
  });
});
