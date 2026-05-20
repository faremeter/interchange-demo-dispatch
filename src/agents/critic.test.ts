// Per-task critic tool-surface tests.
//
// `buildCriticTools` is the deterministic surface the critic agent
// exposes. The agent's reactor turns model output into `ToolCall`s; that
// reactor is `@intx/agent`'s responsibility. Here we drive the same
// `ToolCall` shape directly so every assertion lives in this task's
// scope. Mirrors the pattern in `planner.test.ts`.
//
// Coverage:
//   - Happy path: scripted "model" reads the diff, calls recordVerdict
//     with status=pass and no findings, Promise resolves.
//   - Amend path: scripted "model" reads a buggy diff, calls
//     recordVerdict with status=amend + one blocking finding.
//   - newTests path: scripted "model" includes newTests; verdict
//     captured correctly.
//   - Read-only surface: only read_file / grep / search_files +
//     recordVerdict are advertised.
//   - Path-escape: reads outside the worktree are rejected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { buildCriticTools, type CriticVerdict } from "./critic.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURES_ROOT = join(REPO_ROOT, "tests", "fixtures", "critic");

function asFullHandler(t: AgentTool) {
  if (t.kind !== "full") {
    throw new Error(
      `expected tool to be full-handler AgentTool, got kind=${t.kind}`,
    );
  }
  return t.handler;
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) {
    throw new Error(`expected tool "${name}" to be registered`);
  }
  return found;
}

function makeCall(
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}-1`,
): ToolCall {
  return { id, name, arguments: args };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

async function invoke(
  t: AgentTool,
  args: Record<string, unknown>,
  id?: string,
): Promise<ToolResult> {
  const handler = asFullHandler(t);
  return handler(makeCall(t.definition.name, args, id), neverAbort());
}

let workRoot: string;
let worktreePath: string;

async function stageFixture(name: "clean-task" | "buggy-task") {
  worktreePath = join(workRoot, name);
  await cp(join(FIXTURES_ROOT, name), worktreePath, { recursive: true });
}

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "intx-critic-test-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("buildCriticTools", () => {
  test("happy path: read the diff, record pass verdict, Promise resolves", async () => {
    await stageFixture("clean-task");
    const tools = buildCriticTools({ taskWorktreePath: worktreePath });
    const readFile = findTool(tools.agentTools, "read_file");
    const recordVerdict = findTool(tools.agentTools, "recordVerdict");

    const readResult = await invoke(readFile, {
      path: join(worktreePath, "src", "greet.ts.txt"),
    });
    expect(readResult.isError).toBeUndefined();
    if (typeof readResult.content === "string") {
      expect(readResult.content).toContain("hello,");
    }

    const verdictArgs: CriticVerdict = {
      taskId: "clean-task",
      status: "pass",
      findings: [],
    };
    const res = await invoke(recordVerdict, verdictArgs);
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("ok");

    const resolved = await tools.awaitVerdict;
    expect(resolved).toEqual(verdictArgs);
  });

  test("amend path: read a buggy diff, record amend verdict with one blocking finding", async () => {
    await stageFixture("buggy-task");
    const tools = buildCriticTools({ taskWorktreePath: worktreePath });
    const readFile = findTool(tools.agentTools, "read_file");
    const recordVerdict = findTool(tools.agentTools, "recordVerdict");

    const readResult = await invoke(readFile, {
      path: join(worktreePath, "src", "math.ts.txt"),
    });
    expect(readResult.isError).toBeUndefined();
    // The fixture's `add` returns `a - b`, an obvious bug for a function
    // claimed to compute a sum.
    if (typeof readResult.content === "string") {
      expect(readResult.content).toContain("a - b");
    }

    const verdictArgs: CriticVerdict = {
      taskId: "buggy-task",
      status: "amend",
      findings: [
        {
          id: "f1",
          severity: "blocking",
          description: "add() subtracts instead of summing its arguments",
          filePath: "src/math.ts",
          lineRange: [2, 2],
        },
      ],
    };
    const res = await invoke(recordVerdict, verdictArgs);
    expect(res.isError).toBeUndefined();

    const resolved = await tools.awaitVerdict;
    expect(resolved.status).toBe("amend");
    expect(resolved.findings.length).toBe(1);
    expect(resolved.findings[0]?.severity).toBe("blocking");
    expect(resolved.findings[0]?.description).toMatch(/subtracts/);
  });

  test("newTests path: verdict carries newTests array through to the resolved value", async () => {
    await stageFixture("buggy-task");
    const tools = buildCriticTools({ taskWorktreePath: worktreePath });
    const recordVerdict = findTool(tools.agentTools, "recordVerdict");

    const verdictArgs: CriticVerdict = {
      taskId: "buggy-task",
      status: "amend",
      findings: [
        {
          id: "f1",
          severity: "blocking",
          description: "add() is wrong; needs a test",
          filePath: "src/math.ts",
          lineRange: null,
        },
      ],
      newTests: ["src/math.test.ts"],
    };
    const res = await invoke(recordVerdict, verdictArgs);
    expect(res.isError).toBeUndefined();

    const resolved = await tools.awaitVerdict;
    expect(resolved.newTests).toEqual(["src/math.test.ts"]);
  });

  test("recordVerdict with an invalid status is rejected and the Promise stays unresolved", async () => {
    await stageFixture("clean-task");
    const tools = buildCriticTools({ taskWorktreePath: worktreePath });
    const recordVerdict = findTool(tools.agentTools, "recordVerdict");

    const res = await invoke(recordVerdict, {
      taskId: "clean-task",
      status: "nope",
      findings: [],
    });
    expect(res.isError).toBe(true);

    const sentinel = Symbol("pending");
    const race = await Promise.race([
      tools.awaitVerdict,
      new Promise<typeof sentinel>((r) =>
        setTimeout(() => {
          r(sentinel);
        }, 20),
      ),
    ]);
    expect(race).toBe(sentinel);
  });

  test("only read-side posix tools are advertised; write/edit/shell are not", async () => {
    await stageFixture("clean-task");
    const tools = buildCriticTools({ taskWorktreePath: worktreePath });
    const advertised = tools.agentTools.map((t) => t.definition.name).sort();
    expect(advertised).toEqual(
      ["grep", "read_file", "recordVerdict", "search_files"].sort(),
    );
  });

  test("path-escape: reading outside the worktree is rejected", async () => {
    await stageFixture("clean-task");
    const tools = buildCriticTools({ taskWorktreePath: worktreePath });
    const readFile = findTool(tools.agentTools, "read_file");

    // Try to read a sibling tempdir created next to the worktree.
    const outside = join(workRoot, "should-be-unreachable.txt");
    const res = await invoke(readFile, { path: outside });
    expect(res.isError).toBe(true);
    if (typeof res.content === "string") {
      expect(res.content).toMatch(/outside the configured root/);
    }
  });
});
