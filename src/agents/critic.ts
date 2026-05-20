// Per-task critic agent role.
//
// The critic reviews one implementer task's output without ability to
// mutate anything. Its surface is:
//
//   - Read-only posix tools (`read_file`, `grep`, `search_files`) scoped
//     to the task's worktree via `createPosixTools` + path-escape
//     middleware. Write / edit / shell tools are not advertised.
//   - A single terminal tool `recordVerdict` whose arguments are
//     validated against `criticVerdictSchema`. On success the helper's
//     Promise resolves with the validated verdict (the orchestrator's
//     5d-gate-level then folds it into the task's `critiqueVerdicts` and
//     applies any `newTests`).
//
// Critics MUST NOT create files themselves. If they want to suggest a
// new test, they declare it via `newTests: string[]`; the orchestrator /
// fix agent (5d) is responsible for the actual file. This boundary is
// enforced structurally — no write tools are exposed.

import {
  createAgent,
  type Agent,
  type AgentTool,
  fromToolRunner,
} from "@intx/agent";
import type { Dependencies } from "@intx/inference";
import {
  createPosixTools,
  type Middleware,
  type ToolHandler,
} from "@intx/tools-posix";
import type { ProviderConfig, ToolDefinition } from "@intx/types/runtime";

import { createPathEscapeMiddleware } from "../path-escape.js";
import { terminalTool } from "../terminal-tool.js";
import {
  criticVerdictSchema,
  type CriticVerdict,
} from "./critic-types.js";

const READ_TOOL_NAMES = new Set(["read_file", "grep", "search_files"]);

const DEFAULT_SYSTEM_PROMPT = [
  "You are a per-task critic.",
  "",
  "You have read-only access to a single task's worktree. Read the task's plan.md and output.yaml, inspect the code the implementer touched (filesModified), and decide whether the work satisfies the plan.",
  "",
  "Call the `recordVerdict` terminal tool exactly once when you are done. Its arguments are:",
  "  - `taskId`: the id of the task you are critiquing.",
  "  - `status`: 'pass' if the work satisfies the plan with no blocking issues, 'amend' if there are blocking findings the implementer should fix, 'fail' for unrecoverable defects.",
  "  - `findings`: array of findings (id, severity 'blocking' | 'advisory', description, filePath | null, lineRange | null). Empty array on a clean pass.",
  "  - `newTests` (optional): array of test-file paths you want the fix agent to create. You cannot write files yourself; this is the only mechanism for proposing new tests.",
  "",
  "You have no write tools, no shell tools, and no git access. Read-only is your entire surface.",
].join("\n");

export interface CreateCriticAgentOptions {
  /**
   * Absolute path to the task's worktree. Used as both the posix tools'
   * `cwd` and the path-escape middleware's `root`. The critic can read
   * anything under this directory; reads outside it are rejected by the
   * middleware.
   */
  readonly taskWorktreePath: string;
  /**
   * Absolute path to the task's `plan.md`. Surfaced for the orchestrator's
   * seed-message construction; this factory does not load it itself.
   */
  readonly taskPlanPath: string;
  /**
   * Absolute path to the task's `output.yaml`. Same role as `taskPlanPath`
   * — included on the options for orchestrator use; not read here.
   */
  readonly taskOutputPath: string;
  /**
   * Additional evidence files (e.g. `verification.log`) the orchestrator
   * intends to surface to the critic in its seed message. Recorded here
   * so the surface is documented; not consumed by the factory.
   */
  readonly evidencePaths: readonly string[];
  /**
   * Absolute path to the agent's private isogit-backed context directory.
   * MUST be unique per agent.
   */
  readonly contextDir: string;
  /** Model identifier passed through to the provider config. */
  readonly model: string;
  /** Provider base URL. */
  readonly baseURL: string;
  /** Provider API key. */
  readonly apiKey: string;
  /**
   * Optional provider name. Defaults to "anthropic" (Claude is the brief's
   * primary target). Override when wiring to a different upstream.
   */
  /** Inference adapter (e.g. "openai", "anthropic"). Required. */
  readonly adapter: string;
  /** Optional system-prompt override. */
  readonly systemPrompt?: string;
  /**
   * Inference-layer Dependencies forwarded to `createAgent`; tests pass
   * `setupHarness().deps`. Production callers omit.
   */
  readonly deps?: Dependencies;
}

export interface CriticAgent {
  readonly agent: Agent;
  /**
   * Resolves when the critic calls `recordVerdict` with valid arguments.
   * The orchestrator awaits this in parallel with the agent's reactor
   * loop and calls `agent.close()` once it resolves.
   */
  readonly awaitVerdict: Promise<CriticVerdict>;
}

export async function createCriticAgent(
  options: CreateCriticAgentOptions,
): Promise<CriticAgent> {
  const surface = buildCriticTools({
    taskWorktreePath: options.taskWorktreePath,
  });

  const providerConfig: ProviderConfig = {
    provider: options.adapter,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    model: options.model,
  };

  const agent = await createAgent({
    contextDir: options.contextDir,
    providers: [providerConfig],
    defaultModel: options.model,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    tools: surface.agentTools,
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  });

  return {
    agent,
    awaitVerdict: surface.awaitVerdict,
  };
}

interface CriticToolBundle {
  readonly agentTools: AgentTool[];
  readonly awaitVerdict: Promise<CriticVerdict>;
}

/**
 * Exported for tests so the tool surface can be exercised against direct
 * `ToolCall` invocations without spinning up `createAgent`. Production
 * callers should use `createCriticAgent`.
 */
export function buildCriticTools(
  options: Pick<CreateCriticAgentOptions, "taskWorktreePath">,
): CriticToolBundle {
  const readTools = buildReadOnlyPosixTools(options.taskWorktreePath);
  const verdict = terminalTool("recordVerdict", criticVerdictSchema);

  return {
    agentTools: [...readTools, verdict.tool],
    awaitVerdict: verdict.awaitTermination(),
  };
}

function buildReadOnlyPosixTools(root: string): AgentTool[] {
  const posix = createPosixTools({ cwd: root });
  const escape = createPathEscapeMiddleware({ root });

  const escapedRun = wrapRunner(posix.run.bind(posix), escape);

  const readDefinitions: ToolDefinition[] = posix.definitions.filter((def) =>
    READ_TOOL_NAMES.has(def.name),
  );

  return fromToolRunner({
    definitions: readDefinitions,
    run: escapedRun,
  });
}

function wrapRunner(base: ToolHandler, middleware: Middleware): ToolHandler {
  return middleware(base);
}

export {
  criticVerdictSchema,
  findingSchema,
  type CriticVerdict,
  type CriticFinding,
} from "./critic-types.js";
export { DEFAULT_SYSTEM_PROMPT as CRITIC_DEFAULT_SYSTEM_PROMPT };
