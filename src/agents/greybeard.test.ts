// Integration tests for createGreybeardAgent / buildGreybeardTools.
//
// The tool-surface tests drive `buildGreybeardTools` directly so they
// exercise every middleware path (path-escape, allowlist-bypass, terminal
// validation) without standing up a real Agent or making HTTP calls. The
// end-to-end tests (accept/reject/escalate verdicts, empty-rationale retry)
// drive `createGreybeardAgent` with a scripted `ReactorDirector` so the
// agent's reactor loop is exercised but the inference layer is not.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentClosedError, type Agent, type AgentTool } from "@intx/agent";
import type {
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";

import type { Deviation } from "../state/types.js";
import {
  buildGreybeardSeedMessage,
  buildGreybeardTools,
  createGreybeardAgent,
  type GreybeardVerdictPayload,
} from "./greybeard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE_SOURCE = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "greybeard",
  "sample-task",
);

const PROVIDER = {
  baseURL: "https://example.invalid",
  apiKey: "test-key",
  model: "claude-test",
    adapter: "anthropic",
} as const;

const SAMPLE_DEVIATION: Deviation = {
  id: "dev-1",
  severity: "moderate",
  category: "scope",
  description:
    "Added a new dev dependency (canonical-json) even though the plan forbids it.",
  affectedFiles: ["package.json"],
};

type ScriptStep =
  | { type: "executeTools"; calls: ToolCall[] }
  | { type: "done" };

function scriptedDirector(
  steps: ScriptStep[],
  onToolDone?: (result: ToolResult) => void,
): ReactorDirector {
  let cursor = 0;
  const nextOrDone = (caps: ReactorCapabilities) => {
    if (cursor < steps.length) {
      const step = steps[cursor++];
      if (step === undefined) return caps.done();
      if (step.type === "executeTools") return caps.executeTools(step.calls);
      return caps.done();
    }
    return caps.done();
  };

  return {
    async decide(
      event: ReactorInboundEvent,
      _state: ReactorState,
      caps: ReactorCapabilities,
    ) {
      switch (event.type) {
        case "message.received":
          return nextOrDone(caps);
        case "tool.done":
          if (onToolDone !== undefined) onToolDone(event.result);
          return nextOrDone(caps);
        case "abort":
          return caps.done();
        case "inference.done":
        case "inference.error":
        case "reactor.gate.cleared":
          return caps.done();
      }
    },
  };
}

function fireAndForgetSend(agent: Agent, content: string): void {
  agent.send(content).catch((err: unknown) => {
    if (err instanceof AgentClosedError) return;
    throw err;
  });
}

function asFullHandler(t: AgentTool) {
  if (t.kind !== "full") {
    throw new Error(`expected tool ${t.definition.name} to be full-handler`);
  }
  return t.handler;
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) throw new Error(`tool "${name}" not found`);
  return found;
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

async function invoke(
  tool: AgentTool,
  args: Record<string, unknown>,
  id = `call-${tool.definition.name}-1`,
): Promise<ToolResult> {
  const handler = asFullHandler(tool);
  return handler({ id, name: tool.definition.name, arguments: args }, neverAbort());
}

let workRoot: string;
let planPath: string;
let outputPath: string;
let worktreePath: string;
let contextDir: string;
let outsideFilePath: string;

beforeEach(async () => {
  workRoot = realpathSync(await mkdtemp(join(tmpdir(), "intx-greybeard-")));
  const fixtureCopy = join(workRoot, "task");
  await cp(FIXTURE_SOURCE, fixtureCopy, { recursive: true });
  planPath = join(fixtureCopy, "plan.md");
  outputPath = join(fixtureCopy, "output.yaml");
  worktreePath = join(fixtureCopy, "worktree");
  contextDir = join(workRoot, "agent-ctx");

  // Sibling file outside both the worktree and the allowlist; reads against
  // this path must be rejected by path-escape.
  outsideFilePath = join(workRoot, "secrets.txt");
  await writeFile(outsideFilePath, "do not read me\n");
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("buildGreybeardTools", () => {
  test("tool surface advertises only read tools plus the terminal verdict tool", () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const names = tools.agentTools.map((t) => t.definition.name).sort();
    expect(names).toEqual(
      ["grep", "read_file", "recordGreybeardVerdict", "search_files"].sort(),
    );
  });

  test("no advertised tool name suggests recursion into another agent", () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const names = tools.agentTools
      .map((t) => t.definition.name)
      .filter((n) => n !== "recordGreybeardVerdict");
    const forbidden = [/consult/i, /spawn/i, /invoke.*agent/i, /greybeard/i];
    for (const n of names) {
      for (const pat of forbidden) {
        expect(pat.test(n)).toBe(false);
      }
    }
  });

  test("read_file inside the worktree succeeds", async () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const readFile = findTool(tools.agentTools, "read_file");
    const result = await invoke(readFile, {
      path: join(worktreePath, "greet.ts.txt"),
    });
    expect(result.isError).toBeUndefined();
    if (typeof result.content === "string") {
      expect(result.content).toContain("hello, world");
    }
  });

  test("read_file on the plan path (outside worktree, on allowlist) succeeds", async () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const readFile = findTool(tools.agentTools, "read_file");
    const result = await invoke(readFile, { path: planPath });
    expect(result.isError).toBeUndefined();
    if (typeof result.content === "string") {
      expect(result.content).toContain("## Objective");
    }
  });

  test("read_file on the output path (outside worktree, on allowlist) succeeds", async () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const readFile = findTool(tools.agentTools, "read_file");
    const result = await invoke(readFile, { path: outputPath });
    expect(result.isError).toBeUndefined();
    if (typeof result.content === "string") {
      expect(result.content).toContain("dev-1");
    }
  });

  test("read_file on a sibling file outside the worktree and not on the allowlist is rejected", async () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const readFile = findTool(tools.agentTools, "read_file");
    const result = await invoke(readFile, { path: outsideFilePath });
    expect(result.isError).toBe(true);
    if (typeof result.content === "string") {
      expect(result.content).toContain("outside the configured root");
    }
  });

  test("recordGreybeardVerdict rejects an empty rationale (schema-enforced)", async () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const submit = findTool(tools.agentTools, "recordGreybeardVerdict");
    const result = await invoke(submit, {
      taskId: "example-task",
      deviationId: "dev-1",
      verdict: "accept",
      rationale: "",
    });
    expect(result.isError).toBe(true);
    if (typeof result.content === "string") {
      expect(result.content).toMatch(/rationale/i);
    }

    // Promise must NOT resolve on validation failure.
    const sentinel = Symbol("pending");
    const winner = await Promise.race([
      tools.awaitVerdict,
      new Promise<typeof sentinel>((res) =>
        setTimeout(() => {
          res(sentinel);
        }, 20),
      ),
    ]);
    expect(winner).toBe(sentinel);
  });

  test("recordGreybeardVerdict rejects an out-of-enum verdict", async () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const submit = findTool(tools.agentTools, "recordGreybeardVerdict");
    const result = await invoke(submit, {
      taskId: "example-task",
      deviationId: "dev-1",
      verdict: "maybe",
      rationale: "I'm not sure",
    });
    expect(result.isError).toBe(true);
  });

  test("recordGreybeardVerdict resolves the Promise on a valid accept payload", async () => {
    const tools = buildGreybeardTools({ worktreePath, planPath, outputPath });
    const submit = findTool(tools.agentTools, "recordGreybeardVerdict");
    const payload: GreybeardVerdictPayload = {
      taskId: "example-task",
      deviationId: "dev-1",
      verdict: "accept",
      rationale: "Reviewed the plan and output; the dependency is benign.",
    };
    const result = await invoke(submit, payload);
    expect(result.isError).toBeUndefined();
    const resolved = await tools.awaitVerdict;
    expect(resolved).toEqual(payload);
  });
});

describe("createGreybeardAgent", () => {
  test("accept verdict resolves awaitVerdict with the validated payload", async () => {
    const payload: GreybeardVerdictPayload = {
      taskId: "example-task",
      deviationId: SAMPLE_DEVIATION.id,
      verdict: "accept",
      rationale: "Plan allows benign vendored helpers; the change is in scope.",
    };

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit",
            name: "recordGreybeardVerdict",
            arguments: payload,
          },
        ],
      },
    ]);

    const gb = await createGreybeardAgent({
      taskId: "example-task",
      deviation: SAMPLE_DEVIATION,
      planPath,
      outputPath,
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(gb.agent, "go");
      const resolved = await gb.awaitVerdict;
      expect(resolved).toEqual(payload);
    } finally {
      await gb.agent.close();
    }
  });

  test("reject verdict resolves awaitVerdict with the validated payload", async () => {
    const payload: GreybeardVerdictPayload = {
      taskId: "example-task",
      deviationId: SAMPLE_DEVIATION.id,
      verdict: "reject",
      rationale:
        "The plan explicitly forbids new third-party dependencies; the task should be re-dispatched.",
    };

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit",
            name: "recordGreybeardVerdict",
            arguments: payload,
          },
        ],
      },
    ]);

    const gb = await createGreybeardAgent({
      taskId: "example-task",
      deviation: SAMPLE_DEVIATION,
      planPath,
      outputPath,
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(gb.agent, "go");
      const resolved = await gb.awaitVerdict;
      expect(resolved).toEqual(payload);
    } finally {
      await gb.agent.close();
    }
  });

  test("escalate verdict resolves awaitVerdict with the validated payload", async () => {
    const payload: GreybeardVerdictPayload = {
      taskId: "example-task",
      deviationId: SAMPLE_DEVIATION.id,
      verdict: "escalate",
      rationale:
        "I cannot tell from the available context whether this dependency is acceptable; operator must decide.",
    };

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit",
            name: "recordGreybeardVerdict",
            arguments: payload,
          },
        ],
      },
    ]);

    const gb = await createGreybeardAgent({
      taskId: "example-task",
      deviation: SAMPLE_DEVIATION,
      planPath,
      outputPath,
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(gb.agent, "go");
      const resolved = await gb.awaitVerdict;
      expect(resolved).toEqual(payload);
    } finally {
      await gb.agent.close();
    }
  });

  test("empty rationale yields isError; the model can retry with a valid rationale", async () => {
    const validPayload: GreybeardVerdictPayload = {
      taskId: "example-task",
      deviationId: SAMPLE_DEVIATION.id,
      verdict: "accept",
      rationale: "After a second look the deviation is harmless.",
    };

    let firstAttempt: ToolResult | undefined;
    const director = scriptedDirector(
      [
        {
          type: "executeTools",
          calls: [
            {
              id: "c-bad",
              name: "recordGreybeardVerdict",
              arguments: {
                taskId: "example-task",
                deviationId: SAMPLE_DEVIATION.id,
                verdict: "accept",
                rationale: "",
              },
            },
          ],
        },
        {
          type: "executeTools",
          calls: [
            {
              id: "c-good",
              name: "recordGreybeardVerdict",
              arguments: validPayload,
            },
          ],
        },
      ],
      (result) => {
        if (result.callId === "c-bad") firstAttempt = result;
      },
    );

    const gb = await createGreybeardAgent({
      taskId: "example-task",
      deviation: SAMPLE_DEVIATION,
      planPath,
      outputPath,
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(gb.agent, "go");
      const resolved = await gb.awaitVerdict;
      expect(firstAttempt).toBeDefined();
      expect(firstAttempt?.isError).toBe(true);
      expect(resolved).toEqual(validPayload);
    } finally {
      await gb.agent.close();
    }
  });

  test("read_file on the plan path during a real agent run is permitted", async () => {
    const payload: GreybeardVerdictPayload = {
      taskId: "example-task",
      deviationId: SAMPLE_DEVIATION.id,
      verdict: "accept",
      rationale: "After reading the plan, the deviation is acceptable.",
    };

    let observedRead: ToolResult | undefined;
    const director = scriptedDirector(
      [
        {
          type: "executeTools",
          calls: [
            {
              id: "c-read-plan",
              name: "read_file",
              arguments: { path: planPath },
            },
          ],
        },
        {
          type: "executeTools",
          calls: [
            {
              id: "c-submit",
              name: "recordGreybeardVerdict",
              arguments: payload,
            },
          ],
        },
      ],
      (result) => {
        if (result.callId === "c-read-plan") observedRead = result;
      },
    );

    const gb = await createGreybeardAgent({
      taskId: "example-task",
      deviation: SAMPLE_DEVIATION,
      planPath,
      outputPath,
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(gb.agent, "go");
      const resolved = await gb.awaitVerdict;
      expect(resolved).toEqual(payload);
      expect(observedRead).toBeDefined();
      expect(observedRead?.isError).toBeUndefined();
      if (typeof observedRead?.content === "string") {
        expect(observedRead.content).toContain("## Objective");
      }
    } finally {
      await gb.agent.close();
    }
  });
});

describe("buildGreybeardSeedMessage", () => {
  test("composes a seed mentioning all required fields", () => {
    const seed = buildGreybeardSeedMessage(
      "example-task",
      SAMPLE_DEVIATION,
      planPath,
      outputPath,
      worktreePath,
    );
    expect(seed).toContain("example-task");
    expect(seed).toContain(planPath);
    expect(seed).toContain(outputPath);
    expect(seed).toContain(worktreePath);
    expect(seed).toContain("dev-1");
    expect(seed).toContain("moderate");
    expect(seed).toContain("scope");
    expect(seed).toContain("package.json");
    expect(seed).toContain("recordGreybeardVerdict");
  });
});
