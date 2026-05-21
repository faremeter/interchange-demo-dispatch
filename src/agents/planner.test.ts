// Planner tool-surface integration tests.
//
// `buildPlannerTools` is the deterministic surface the planner agent
// exposes. The agent's reactor turns model output into `ToolCall`s; that
// reactor is `@intx/agent`'s responsibility and is exercised by its own
// test suite. Here we drive the same `ToolCall` shape directly so that
// every assertion lives in this task's scope:
//
//   - Successful proposal flow: three tasks proposed in valid order,
//     `finalizePlan` resolves with the correctly-leveled DAG.
//   - Correction loop: a dangling-dep proposal is rejected; the model can
//     then propose the missing task and retry.
//   - Path-escape: a read tool call against a path outside the target repo
//     is rejected by the middleware, not the underlying read handler.
//   - Plan-markdown minimum length is enforced.
//   - `finalizePlan` with no proposals is rejected.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import {
  buildPlannerTools,
  buildPlannerSeedMessage,
  type FinalizedPlan,
} from "./planner";

const LONG_PLAN_BODY = [
  "## Objective",
  "Do the thing described in the parent spec.",
  "",
  "## Requirements Covered",
  "Whatever the spec mandates for this slice.",
  "",
  "## Context",
  "The upstream tasks have shipped their outputs.",
  "",
  "## Files to Modify",
  "src/whatever.ts",
  "",
  "## Constraints",
  "Do not run mutating git operations.",
  "",
  "## Verification",
  "bun run build, bun run lint, bun run test.",
  "",
  "## Deviation Reporting",
  "Report any deviation in output.yaml.",
  "",
  "## Subagent Responsibility",
  "Read this plan fully before starting.",
  "",
  "## Output Contract",
  "Write output.yaml per the dispatch contract.",
].join("\n");

function asFullHandler(t: AgentTool) {
  if (t.kind !== "full") {
    throw new Error(
      `expected proposeTask/finalizePlan to be full-handler AgentTools, got kind=${t.kind}`,
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
  tool: AgentTool,
  args: Record<string, unknown>,
  id?: string,
): Promise<ToolResult> {
  const handler = asFullHandler(tool);
  return handler(makeCall(tool.definition.name, args, id), neverAbort());
}

function proposeArgs(overrides: {
  idHint: string;
  level: number;
  dependsOn?: string[];
}) {
  return {
    idHint: overrides.idHint,
    level: overrides.level,
    dependsOn: overrides.dependsOn ?? [],
    objective: `Do the work for ${overrides.idHint}`,
    planMarkdown: LONG_PLAN_BODY,
    agentType: "general",
    class: "feature",
    verifyCommands: ["bun run build"],
    critiqueEnabled: true,
  };
}

function finalizeArgs(
  overrides: Partial<{
    verificationMode:
      | "baseline-equality"
      | "no-new-failures"
      | "skip-comparison";
    verificationModeRationale: string;
  }> = {},
) {
  return {
    verificationMode: overrides.verificationMode ?? "baseline-equality",
    verificationModeRationale:
      overrides.verificationModeRationale ??
      "test default — preserve baseline output",
  };
}

let targetRepo: string;
let outsideDir: string;

beforeAll(async () => {
  targetRepo = realpathSync(await mkdtemp(path.join(tmpdir(), "planner-target-")));
  outsideDir = realpathSync(await mkdtemp(path.join(tmpdir(), "planner-outside-")));
  await mkdir(path.join(targetRepo, "src"), { recursive: true });
  await writeFile(path.join(targetRepo, "src", "hello.ts"), "export {};\n");
  await writeFile(path.join(targetRepo, "spec.md"), "# Fixture spec\n");
  await writeFile(path.join(outsideDir, "secrets.txt"), "do not read me\n");
});

afterAll(async () => {
  await rm(targetRepo, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("buildPlannerTools", () => {
  test("three-task happy path resolves the Promise with the correctly-leveled DAG", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");
    const finalize = findTool(tools.agentTools, "finalizePlan");

    const r1 = await invoke(propose, proposeArgs({ idHint: "bootstrap", level: 1 }));
    expect(r1.isError).toBeUndefined();
    expect(r1.content).toBe('accepted: id="bootstrap"');

    const r2 = await invoke(
      propose,
      proposeArgs({ idHint: "feature", level: 2, dependsOn: ["bootstrap"] }),
    );
    expect(r2.isError).toBeUndefined();

    const r3 = await invoke(
      propose,
      proposeArgs({ idHint: "smoke-test", level: 3, dependsOn: ["feature"] }),
    );
    expect(r3.isError).toBeUndefined();

    const fin = await invoke(finalize, finalizeArgs());
    expect(fin.isError).toBeUndefined();
    expect(fin.content).toBe("ok");

    const plan: FinalizedPlan = await tools.awaitFinalizedPlan;
    expect(plan.tasks.map((t) => t.id)).toEqual([
      "bootstrap",
      "feature",
      "smoke-test",
    ]);
    expect(plan.levels).toEqual({
      bootstrap: 1,
      feature: 2,
      "smoke-test": 3,
    });
  });

  test("dangling-dep proposal rejected; correction loop succeeds", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");
    const finalize = findTool(tools.agentTools, "finalizePlan");

    const bad = await invoke(
      propose,
      proposeArgs({ idHint: "feature", level: 2, dependsOn: ["ghost"] }),
    );
    expect(bad.isError).toBe(true);
    expect(typeof bad.content).toBe("string");
    if (typeof bad.content === "string") {
      expect(bad.content).toMatch(/"ghost"/);
      expect(bad.content).toMatch(/not yet proposed/);
    }

    // Model corrects: proposes the missing task first, then re-proposes the
    // dependent task.
    const fix1 = await invoke(propose, proposeArgs({ idHint: "bootstrap", level: 1 }));
    expect(fix1.isError).toBeUndefined();
    const fix2 = await invoke(
      propose,
      proposeArgs({ idHint: "feature", level: 2, dependsOn: ["bootstrap"] }),
    );
    expect(fix2.isError).toBeUndefined();

    const fin = await invoke(finalize, finalizeArgs());
    expect(fin.isError).toBeUndefined();

    const plan = await tools.awaitFinalizedPlan;
    expect(plan.tasks.map((t) => t.id)).toEqual(["bootstrap", "feature"]);
    expect(plan.levels).toEqual({ bootstrap: 1, feature: 2 });
  });

  test("finalizePlan with inconsistent declared level is rejected; model can retry", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");
    const finalize = findTool(tools.agentTools, "finalizePlan");

    await invoke(propose, proposeArgs({ idHint: "bootstrap", level: 1 }));
    // The runtime accepts a structurally-valid proposal even if its declared
    // level is wrong; only finalizePlan catches it (validateDAG owns that
    // constraint).
    await invoke(
      propose,
      proposeArgs({ idHint: "feature", level: 4, dependsOn: ["bootstrap"] }),
    );

    const badFin = await invoke(finalize, finalizeArgs());
    expect(badFin.isError).toBe(true);
    if (typeof badFin.content === "string") {
      expect(badFin.content).toMatch(/DAG validation failed/);
      expect(badFin.content).toMatch(/"feature"/);
    }

    // The Promise must stay unresolved so the model can propose corrections.
    const sentinel = Symbol("pending");
    const race = await Promise.race([
      tools.awaitFinalizedPlan,
      new Promise<typeof sentinel>((r) =>
        setTimeout(() => {
          r(sentinel);
        }, 20),
      ),
    ]);
    expect(race).toBe(sentinel);
  });

  test("planMarkdown shorter than 200 chars is rejected at proposeTask", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");

    const args = proposeArgs({ idHint: "tiny", level: 1 });
    args.planMarkdown = "too short";
    const res = await invoke(propose, args);
    expect(res.isError).toBe(true);
    if (typeof res.content === "string") {
      expect(res.content).toMatch(/planMarkdown/);
    }
  });

  test("invalid idHint (uppercase) is rejected", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");

    const args = proposeArgs({ idHint: "Bootstrap", level: 1 });
    const res = await invoke(propose, args);
    expect(res.isError).toBe(true);
  });

  test("finalizePlan with no proposals is rejected", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const finalize = findTool(tools.agentTools, "finalizePlan");
    const res = await invoke(finalize, finalizeArgs());
    expect(res.isError).toBe(true);
    if (typeof res.content === "string") {
      expect(res.content).toMatch(/no tasks/);
    }
  });

  test("re-finalize after success is rejected", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");
    const finalize = findTool(tools.agentTools, "finalizePlan");

    await invoke(propose, proposeArgs({ idHint: "only", level: 1 }));
    const first = await invoke(finalize, finalizeArgs());
    expect(first.isError).toBeUndefined();

    const second = await invoke(finalize, finalizeArgs());
    expect(second.isError).toBe(true);
    if (typeof second.content === "string") {
      expect(second.content).toMatch(/already finalized/);
    }
  });

  test("proposeTask after finalize is rejected", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");
    const finalize = findTool(tools.agentTools, "finalizePlan");

    await invoke(propose, proposeArgs({ idHint: "only", level: 1 }));
    await invoke(finalize, finalizeArgs());

    const after = await invoke(propose, proposeArgs({ idHint: "late", level: 1 }));
    expect(after.isError).toBe(true);
  });

  test("duplicate idHint generates a uniquified id", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const propose = findTool(tools.agentTools, "proposeTask");
    const finalize = findTool(tools.agentTools, "finalizePlan");

    const first = await invoke(propose, proposeArgs({ idHint: "bootstrap", level: 1 }));
    expect(first.content).toBe('accepted: id="bootstrap"');

    const second = await invoke(propose, proposeArgs({ idHint: "bootstrap", level: 1 }));
    expect(second.content).toBe('accepted: id="bootstrap-2"');

    await invoke(finalize, finalizeArgs());
    const plan = await tools.awaitFinalizedPlan;
    expect(plan.tasks.map((t) => t.id)).toEqual(["bootstrap", "bootstrap-2"]);
  });

  test("only read-side posix tools are advertised; write/edit/shell are not", () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const advertised = tools.agentTools.map((t) => t.definition.name).sort();
    expect(advertised).toEqual(
      ["finalizePlan", "grep", "proposeTask", "read_file", "search_files"].sort(),
    );
  });

  test("path-escape: reading outside the target repo is rejected", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const readFile = findTool(tools.agentTools, "read_file");

    const escapingPath = path.join(outsideDir, "secrets.txt");
    const result = await invoke(readFile, { path: escapingPath });
    expect(result.isError).toBe(true);
    if (typeof result.content === "string") {
      expect(result.content).toMatch(/outside the configured root/);
    }
  });

  test("path-escape: reading a file inside the target repo is allowed", async () => {
    const tools = buildPlannerTools({ targetRepoPath: targetRepo });
    const readFile = findTool(tools.agentTools, "read_file");

    const result = await invoke(readFile, {
      path: path.join(targetRepo, "src", "hello.ts"),
    });
    expect(result.isError).toBeUndefined();
    if (typeof result.content === "string") {
      expect(result.content).toContain("export {}");
    }
  });
});

describe("buildPlannerSeedMessage", () => {
  test("composes spec + skill blob + missing-optional section", () => {
    const seed = buildPlannerSeedMessage({
      specText: "# Spec body",
      specPath: "/tmp/example/spec.md",
      skillBlob: {
        blob: "# === AGENTS.md ===\nproject conventions",
        files: [{ path: "AGENTS.md", bytes: 21 }],
        totalBytes: 21,
        missingOptional: ["CONVENTIONS.md", "README.md"],
      },
    });

    expect(seed).toContain("# Spec (/tmp/example/spec.md)");
    expect(seed).toContain("# Spec body");
    expect(seed).toContain("# Target-repo skill files (1 files, 21 bytes)");
    expect(seed).toContain("project conventions");
    expect(seed).toContain("# Missing optional top-level files");
    expect(seed).toContain("CONVENTIONS.md");
    expect(seed).toContain("README.md");
  });

  test("omits the missing-optional section when nothing is missing", () => {
    const seed = buildPlannerSeedMessage({
      specText: "spec",
      specPath: "/tmp/example/spec.md",
      skillBlob: {
        blob: "blob",
        files: [{ path: "AGENTS.md", bytes: 4 }],
        totalBytes: 4,
        missingOptional: [],
      },
    });
    expect(seed).not.toContain("# Missing optional top-level files");
  });
});
