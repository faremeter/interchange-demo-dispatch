import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import {
  buildAttributionTools,
  buildAttributionSeed,
  recordAttributionArgsSchema,
  validateAttributionResult,
  type AttributionResult,
} from "./attribution-agent.js";

function findTool(
  bundle: ReturnType<typeof buildAttributionTools>,
  name: string,
): AgentTool {
  const t = bundle.agentTools.find((entry) => entry.definition.name === name);
  if (t === undefined) {
    throw new Error(`tool ${name} not present in bundle`);
  }
  return t;
}

function makeCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

async function invoke(tool: AgentTool, call: ToolCall): Promise<ToolResult> {
  if (tool.kind === "string") {
    throw new Error(`unexpected string-kind tool: ${tool.definition.name}`);
  }
  const controller = new AbortController();
  return tool.handler(call, controller.signal);
}

describe("attribution-agent tool surface", () => {
  test("records one failure per call and finalizes", async () => {
    const bundle = buildAttributionTools();
    const record = findTool(bundle, "recordAttribution");
    const finalize = findTool(bundle, "finalizeAttribution");

    const r1 = await invoke(
      record,
      makeCall("c1", "recordAttribution", { failureId: "f1", taskIds: ["t1"] }),
    );
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toBe("recorded");

    const r2 = await invoke(
      record,
      makeCall("c2", "recordAttribution", { failureId: "f2", taskIds: ["t2", "t3"] }),
    );
    expect(r2.isError).toBeFalsy();

    const r3 = await invoke(
      finalize,
      makeCall("c3", "finalizeAttribution", {}),
    );
    expect(r3.isError).toBeFalsy();

    const result = await bundle.awaitAttribution;
    expect(result.attribution).toEqual({ f1: ["t1"], f2: ["t2", "t3"] });
  });

  test("dedupes taskIds within one call while preserving order", async () => {
    const bundle = buildAttributionTools();
    const record = findTool(bundle, "recordAttribution");
    const finalize = findTool(bundle, "finalizeAttribution");

    await invoke(
      record,
      makeCall("c1", "recordAttribution", { failureId: "f1", taskIds: ["a", "b", "a", "c", "b"] }),
    );
    await invoke(finalize, makeCall("c2", "finalizeAttribution", {}));
    const result = await bundle.awaitAttribution;
    expect(result.attribution).toEqual({ f1: ["a", "b", "c"] });
  });

  test("rejects empty taskIds array via schema", async () => {
    const bundle = buildAttributionTools();
    const record = findTool(bundle, "recordAttribution");

    const r = await invoke(
      record,
      makeCall("c1", "recordAttribution", { failureId: "f1", taskIds: [] }),
    );
    expect(r.isError).toBe(true);
  });

  test("rejects missing failureId via schema", async () => {
    const bundle = buildAttributionTools();
    const record = findTool(bundle, "recordAttribution");

    const r = await invoke(
      record,
      makeCall("c1", "recordAttribution", { taskIds: ["t1"] }),
    );
    expect(r.isError).toBe(true);
  });

  test("re-recording the same failureId overrides the prior taskIds", async () => {
    // The orchestrator dedupes-per-call but a *second* call with the
    // same failureId is treated as the agent revising its decision.
    const bundle = buildAttributionTools();
    const record = findTool(bundle, "recordAttribution");
    const finalize = findTool(bundle, "finalizeAttribution");

    await invoke(
      record,
      makeCall("c1", "recordAttribution", { failureId: "f1", taskIds: ["wrong"] }),
    );
    await invoke(
      record,
      makeCall("c2", "recordAttribution", { failureId: "f1", taskIds: ["right"] }),
    );
    await invoke(finalize, makeCall("c3", "finalizeAttribution", {}));

    const result = await bundle.awaitAttribution;
    expect(result.attribution).toEqual({ f1: ["right"] });
  });
});

describe("buildAttributionSeed", () => {
  test("renders all four evidence sections", () => {
    const seed = buildAttributionSeed({
      baselineLog: "baseline-text",
      finalLog: "final-text",
      newFailures: [
        { id: "f1", message: "type error", file: "src/x.ts", line: 10 },
        { id: "f2", message: "missing dep", file: null, line: null },
      ],
      tasks: [
        {
          id: "t1",
          objective: "do the thing",
          filesModified: ["src/x.ts"],
          commitSHA: "sha-t1",
          committedDiff: "diff-t1",
          planMarkdown: "plan-t1",
          outputYAML: "yaml-t1",
        },
      ],
    });
    expect(seed).toContain("Baseline build log");
    expect(seed).toContain("baseline-text");
    expect(seed).toContain("Final build log");
    expect(seed).toContain("final-text");
    expect(seed).toContain("- f1 (in src/x.ts:10): type error");
    expect(seed).toContain("- f2: missing dep");
    expect(seed).toContain("### Task t1");
    expect(seed).toContain("commitSHA: sha-t1");
    expect(seed).toContain("diff-t1");
    expect(seed).toContain("plan-t1");
    expect(seed).toContain("yaml-t1");
  });

  test("renders zero-file commit unit marker", () => {
    const seed = buildAttributionSeed({
      baselineLog: "",
      finalLog: "",
      newFailures: [],
      tasks: [
        {
          id: "t2",
          objective: "no files",
          filesModified: [],
          commitSHA: null,
          committedDiff: "",
          planMarkdown: "plan",
          outputYAML: "yaml",
        },
      ],
    });
    expect(seed).toContain("commitSHA: (zero-file commit unit)");
    expect(seed).toContain("filesModified:\n(none)");
  });
});

describe("validateAttributionResult", () => {
  test("accepts a result matching expected failure and task ids", () => {
    const result: AttributionResult = {
      attribution: { f1: ["t1"], f2: ["t1", "t2"] },
    };
    expect(() =>
      validateAttributionResult(result, ["f1", "f2"], ["t1", "t2", "t3"]),
    ).not.toThrow();
  });

  test("throws when failure ids are missing", () => {
    const result: AttributionResult = { attribution: { f1: ["t1"] } };
    expect(() =>
      validateAttributionResult(result, ["f1", "f2"], ["t1"]),
    ).toThrow(/missing=\[f2\]/);
  });

  test("throws when extra failure ids appear", () => {
    const result: AttributionResult = {
      attribution: { f1: ["t1"], extraneous: ["t1"] },
    };
    expect(() =>
      validateAttributionResult(result, ["f1"], ["t1"]),
    ).toThrow(/extra=\[extraneous\]/);
  });

  test("throws when an attribution references an unknown task id", () => {
    const result: AttributionResult = { attribution: { f1: ["bogus"] } };
    expect(() =>
      validateAttributionResult(result, ["f1"], ["t1"]),
    ).toThrow(/unknown task ids: bogus/);
  });

  test("throws when an attribution has an empty taskIds list", () => {
    // The agent-facing schema prevents this; the orchestrator-side
    // validator double-checks to defend against a buggy non-agent
    // caller threading data in directly.
    const result: AttributionResult = { attribution: { f1: [] } };
    expect(() =>
      validateAttributionResult(result, ["f1"], ["t1"]),
    ).toThrow(/empty taskIds/);
  });
});

describe("recordAttributionArgsSchema", () => {
  test("accepts valid arguments", () => {
    const parsed = recordAttributionArgsSchema({
      failureId: "f1",
      taskIds: ["t1"],
    });
    expect(parsed).toEqual({ failureId: "f1", taskIds: ["t1"] });
  });
});
