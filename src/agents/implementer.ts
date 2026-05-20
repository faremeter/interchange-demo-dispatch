// Implementer agent role factory.
//
// Assembles the tool surface the implementer needs to write code inside a
// confined worktree:
//
//   - `createPosixTools({ cwd: worktreePath })` for file/shell access, with
//     `createPathEscapeMiddleware({ root: worktreePath })` composed in to
//     reject any tool argument that resolves outside the worktree.
//   - `createLSPPlugin({ cwd, worktree })` so the model can lean on
//     language-server diagnostics for the codebase it is editing.
//   - A repeatable `recordBuildResult` tool that captures `command`,
//     `exitCode`, and `stdoutTail` triples into a closure-owned array the
//     orchestrator reads out as `recordedBuilds`.
//   - A `submitOutput` terminal tool (built via `terminalTool`) carrying
//     the task's `SubmittedOutput`. Its resolution is exposed as
//     `awaitSubmitOutput` so the orchestrator can race it against the
//     agent's reactor loop.
//
// Deliberately absent from the surface: anything that could mutate git
// state (no `git` tool, no shell escape via `run_shell`'s cwd because the
// path-escape middleware rejects external cwds, no commit/push wrappers).
// State changes only happen via files written inside the worktree, and
// only by the posix tools constrained by the middleware.
//
// Mock-inference / production seam:
//
// `createAgent` accepts an optional `director`. In production the
// orchestrator passes none and the agent uses `createDefaultDirector`
// which calls the configured provider via HTTP. In tests the orchestrator
// (or the test itself) passes a scripted `ReactorDirector` that returns
// `executeTools` actions directly, side-stepping HTTP entirely. The
// factory threads `director` and `deps` through unchanged so both forms
// of caller can drive the same role.

import { tool, type AgentTool } from "@intx/agent";
import { createAgent, type Agent } from "@intx/agent";
import { fromToolRunner } from "@intx/agent";
import {
  createPosixTools,
  type ToolPlugin,
} from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import { type } from "arktype";
import type { Dependencies } from "@intx/inference";
import type { ProviderConfig, ReactorDirector } from "@intx/types/runtime";

import { toolInputSchema } from "../json-schema-fixup.js";
import { createPathEscapeMiddleware } from "../path-escape.js";
import { terminalTool } from "../terminal-tool.js";
import {
  recordedBuildSchema,
  submittedOutputSchema,
  type RecordedBuild,
  type SubmittedOutput,
} from "./implementer-types.js";

const IMPLEMENTER_SYSTEM_PROMPT = `You are the implementer agent. Read your task's plan.md, make the requested changes inside your assigned worktree, and call \`submitOutput\` exactly once when finished. Use \`recordBuildResult\` to log every build/lint/test command you run so the orchestrator can verify your evidence. You have no git access; state changes only via files inside the worktree.`;

export interface CreateImplementerAgentOptions {
  /**
   * Absolute path to the worktree the implementer is confined to. Used as
   * both the posix tools' `cwd` and the path-escape middleware's `root`,
   * and as the LSP plugin's `cwd`/`worktree` so diagnostics target this
   * tree.
   */
  worktreePath: string;
  /**
   * Absolute path to the agent's private isogit-backed context directory.
   * MUST be unique per agent — sharing across roles violates the
   * singleton-per-`contextDir` invariant enforced by `@intx/agent`'s
   * `lock.ts`.
   */
  contextDir: string;
  /** Model identifier passed through to the provider config. */
  model: string;
  /** Provider base URL. */
  baseURL: string;
  /** Provider API key. */
  apiKey: string;
  /**
   * Optional director override. Production callers leave this undefined
   * (the default director talks to the model via the provider config).
   * Tests pass a scripted `ReactorDirector` that returns `executeTools`
   * directly to avoid issuing real inference HTTP calls.
   */
  director?: ReactorDirector;
  /**
   * Optional inference dependencies (notably `fetch`). Production callers
   * leave this undefined so the assembly binds `globalThis.fetch`. Tests
   * may pass deps from `@intx/inference-testing` to swap fetch for a
   * deterministic stub.
   */
  deps?: Dependencies;
  /**
   * Optional provider name. Defaults to "anthropic" because the brief
   * targets Claude as the primary model. Override when wiring to a
   * different upstream.
   */
  provider?: string;
}

export interface ImplementerAgent {
  agent: Agent;
  /**
   * Resolves once the implementer calls `submitOutput` with arguments
   * that pass schema validation. The orchestrator awaits this in
   * parallel with the agent's reactor loop and calls `agent.close()`
   * when it resolves.
   */
  awaitSubmitOutput: Promise<SubmittedOutput>;
  /**
   * Read-only view onto every `recordBuildResult` call the agent has
   * made so far, in invocation order. Backed by a closure-owned array
   * that the orchestrator can re-read at any point during or after the
   * agent's lifetime.
   */
  recordedBuilds: readonly RecordedBuild[];
}

function buildRecordBuildResultTool(sink: RecordedBuild[]): AgentTool {
  return tool({
    definition: {
      name: "recordBuildResult",
      description:
        "Record evidence for a build/lint/test command the implementer ran. Callable any number of times; each invocation appends to the orchestrator-visible recordedBuilds list. Required fields: command (string), exitCode (number), stdoutTail (string — last N lines of stdout/stderr).",
      inputSchema: toolInputSchema(recordedBuildSchema),
    },
    handler: async (call) => {
      const parsed = recordedBuildSchema(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          content: parsed.summary,
          isError: true,
        };
      }
      sink.push(parsed);
      return {
        callId: call.id,
        content: "recorded",
      };
    },
  });
}

export async function createImplementerAgent(
  options: CreateImplementerAgentOptions,
): Promise<ImplementerAgent> {
  const recordedBuilds: RecordedBuild[] = [];

  const pathEscapePlugin: ToolPlugin = {
    middleware: createPathEscapeMiddleware({ root: options.worktreePath }),
  };
  const lspPlugin = createLSPPlugin({
    cwd: options.worktreePath,
    worktree: options.worktreePath,
  });

  const posixTools = createPosixTools({
    cwd: options.worktreePath,
    plugins: [pathEscapePlugin, lspPlugin],
  });

  const submit = terminalTool("submitOutput", submittedOutputSchema);
  const recordBuildResult = buildRecordBuildResultTool(recordedBuilds);

  const tools: AgentTool[] = [
    ...fromToolRunner(posixTools),
    recordBuildResult,
    submit.tool,
  ];

  const providerConfig: ProviderConfig = {
    provider: options.provider ?? "anthropic",
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    model: options.model,
  };

  const agent = await createAgent({
    contextDir: options.contextDir,
    providers: [providerConfig],
    defaultModel: options.model,
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    tools,
    ...(options.director !== undefined ? { director: options.director } : {}),
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  });

  return {
    agent,
    awaitSubmitOutput: submit.awaitTermination(),
    recordedBuilds,
  };
}

export type {
  RecordedBuild,
  SubmittedOutput,
  SubmittedDeviation,
} from "./implementer-types.js";
export { submittedOutputSchema, recordedBuildSchema } from "./implementer-types.js";
