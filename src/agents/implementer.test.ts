// Integration tests for createImplementerAgent.
//
// The factory's normal mode talks to a real provider via HTTP. To exercise
// the tool surface without a network we pass a scripted `ReactorDirector`
// that returns `executeTools` actions directly. The scripted director is
// effectively a stand-in for the model: it observes `tool.done` events and
// returns the next tool call (or `done()`) in its script. Every test ends
// either with the scripted director returning `done()` or with the
// `submitOutput` terminal tool resolving `awaitSubmitOutput`, at which
// point the test calls `agent.close()` to release the contextDir lock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { AgentClosedError, AgentInUseError, type Agent } from "@intx/agent";
import type {
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";

import { createImplementerAgent } from "./implementer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE_SOURCE = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "implementer",
  "sample-task",
);

type ScriptStep =
  | { type: "executeTools"; calls: ToolCall[] }
  | { type: "done" };

/**
 * Build a deterministic director that walks a fixed script of steps.
 * Each `executeTools` step is yielded once and only once; after all
 * steps are consumed the director returns `done()` so the reactor
 * shuts down (test-visible failure mode if something else is wrong).
 *
 * `onToolDone` lets a test inspect (or fail) the last tool result —
 * useful for asserting that the path-escape middleware rejected a
 * call before deciding the script's next move.
 */
function scriptedDirector(
  steps: ScriptStep[],
  onToolDone?: (result: ToolResult) => void,
): ReactorDirector {
  let cursor = 0;
  const nextOrDone = (caps: ReactorCapabilities) => {
    if (cursor < steps.length) {
      const step = steps[cursor++];
      if (step === undefined) return caps.done();
      if (step.type === "executeTools") {
        return caps.executeTools(step.calls);
      }
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

const PROVIDER = {
  baseURL: "https://example.invalid",
  apiKey: "test-key",
  model: "claude-test",
    adapter: "anthropic",
} as const;

/**
 * The scripted directors used in these tests intentionally end their
 * cycles with `done()` (no `reply` action), so the agent's `send()`
 * Promise rejects with `AgentClosedError` when the reactor terminates.
 * Tests await `awaitSubmitOutput` instead; this helper swallows the
 * `send()` rejection so it does not surface as an unhandled rejection
 * during the test run.
 */
function fireAndForgetSend(agent: Agent, content: string): void {
  agent.send(content).catch((err: unknown) => {
    if (err instanceof AgentClosedError) return;
    throw err;
  });
}

let workRoot: string;
let worktreePath: string;
let contextDir: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "intx-impl-test-"));
  worktreePath = join(workRoot, "worktree");
  contextDir = join(workRoot, "agent-ctx");
  await cp(FIXTURE_SOURCE, worktreePath, { recursive: true });
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("createImplementerAgent", () => {
  test("happy path: agent writes a file then submits and the Promise resolves", async () => {
    const target = join(worktreePath, "hello.txt");
    const submitArgs = {
      summary: "wrote hello.txt",
      filesModified: ["hello.txt"],
      deviations: [],
      notes: "trivial fixture task",
    };

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-write",
            name: "write_file",
            arguments: { path: target, content: "hi" },
          },
        ],
      },
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit",
            name: "submitOutput",
            arguments: submitArgs,
          },
        ],
      },
    ]);

    const impl = await createImplementerAgent({
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(impl.agent, "go");
      const submitted = await impl.awaitSubmitOutput;
      expect(submitted).toEqual(submitArgs);

      const written = await readFile(target, "utf8");
      expect(written).toBe("hi");
    } finally {
      await impl.agent.close();
    }
  });

  test("path-escape middleware rejects writes outside the worktree", async () => {
    const escapeTarget = "/tmp/intx-impl-should-not-exist.txt";
    let observedWriteResult: ToolResult | undefined;

    const director = scriptedDirector(
      [
        {
          type: "executeTools",
          calls: [
            {
              id: "c-escape",
              name: "write_file",
              arguments: { path: escapeTarget, content: "boom" },
            },
          ],
        },
        {
          type: "executeTools",
          calls: [
            {
              id: "c-submit",
              name: "submitOutput",
              arguments: {
                summary: "attempted escape was blocked",
                filesModified: [],
                deviations: [],
                notes: "write_file outside root returned isError",
              },
            },
          ],
        },
      ],
      (result) => {
        if (result.callId === "c-escape") observedWriteResult = result;
      },
    );

    const impl = await createImplementerAgent({
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(impl.agent, "go");
      const submitted = await impl.awaitSubmitOutput;

      expect(observedWriteResult).toBeDefined();
      expect(observedWriteResult?.isError).toBe(true);
      const content = observedWriteResult?.content;
      expect(typeof content === "string" ? content : "").toContain(
        "outside the configured root",
      );

      // Confirm the file did not get written somewhere else: read should fail.
      let escapeWritten = false;
      try {
        await readFile(escapeTarget, "utf8");
        escapeWritten = true;
      } catch {
        escapeWritten = false;
      }
      expect(escapeWritten).toBe(false);
      expect(submitted.summary).toBe("attempted escape was blocked");
    } finally {
      await impl.agent.close();
    }
  });

  test("submitOutput rejects malformed deviation entries and does not resolve the Promise", async () => {
    const badArgs = {
      summary: "should not pass",
      filesModified: [],
      // Each deviation must have severity/category/description/affectedFiles.
      // "severity" is an enum; "nope" is outside the enum and arktype rejects.
      deviations: [
        {
          severity: "nope",
          category: "scope",
          description: "x",
          affectedFiles: [],
        },
      ],
      notes: "",
    };
    let observedSubmitResult: ToolResult | undefined;

    const director = scriptedDirector(
      [
        {
          type: "executeTools",
          calls: [
            {
              id: "c-bad-submit",
              name: "submitOutput",
              arguments: badArgs,
            },
          ],
        },
      ],
      (result) => {
        if (result.callId === "c-bad-submit") observedSubmitResult = result;
      },
    );

    const impl = await createImplementerAgent({
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(impl.agent, "go");

      // Race awaitSubmitOutput against a short timer; the timer should win
      // because validation failed and the Promise must NOT resolve.
      const sentinel = Symbol("pending");
      const winner = await Promise.race([
        impl.awaitSubmitOutput,
        new Promise<typeof sentinel>((res) =>
          setTimeout(() => {
            res(sentinel);
          }, 50),
        ),
      ]);
      expect(winner).toBe(sentinel);

      expect(observedSubmitResult).toBeDefined();
      expect(observedSubmitResult?.isError).toBe(true);
    } finally {
      await impl.agent.close();
    }
  });

  test("recordBuildResult is repeatable and accumulates in order", async () => {
    const buildA = {
      command: "bun run build",
      exitCode: 0,
      stdoutTail: "compiled cleanly",
    };
    const buildB = {
      command: "bun run lint",
      exitCode: 1,
      stdoutTail: "1 error",
    };

    const director = scriptedDirector([
      {
        type: "executeTools",
        calls: [
          {
            id: "c-build-a",
            name: "recordBuildResult",
            arguments: buildA,
          },
        ],
      },
      {
        type: "executeTools",
        calls: [
          {
            id: "c-build-b",
            name: "recordBuildResult",
            arguments: buildB,
          },
        ],
      },
      {
        type: "executeTools",
        calls: [
          {
            id: "c-submit",
            name: "submitOutput",
            arguments: {
              summary: "ran two builds",
              filesModified: [],
              deviations: [],
              notes: "ok",
            },
          },
        ],
      },
    ]);

    const impl = await createImplementerAgent({
      worktreePath,
      contextDir,
      ...PROVIDER,
      director,
    });

    try {
      fireAndForgetSend(impl.agent, "go");
      await impl.awaitSubmitOutput;
      expect(impl.recordedBuilds).toEqual([buildA, buildB]);
    } finally {
      await impl.agent.close();
    }
  });

  test("two agents on the same contextDir collide per lock.ts", async () => {
    const first = await createImplementerAgent({
      worktreePath,
      contextDir,
      ...PROVIDER,
      director: scriptedDirector([]),
    });

    try {
      await expect(
        createImplementerAgent({
          worktreePath,
          contextDir,
          ...PROVIDER,
          director: scriptedDirector([]),
        }),
      ).rejects.toBeInstanceOf(AgentInUseError);
    } finally {
      await first.agent.close();
    }
  });
});
