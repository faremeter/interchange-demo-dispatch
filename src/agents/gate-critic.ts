// Per-level gate-critic agent role.
//
// The gate critic reviews every task in a level and emits a single
// `recordGateVerdict` covering them all. Its surface is:
//
//   - Read-only posix tools (`read_file`, `grep`, `search_files`) scoped
//     to the run directory via `createPosixTools` + path-escape. This is
//     how the agent reaches each task's `plan.md`, `output.yaml`, and the
//     per-task critic `verdict.yaml` files the orchestrator wrote.
//   - A custom read-only `gitShow` tool that runs `git show <sha>`
//     against the run's target repository (its `cwd`), with `<sha>`
//     restricted to a per-call allowlist sourced from the level's known
//     task `commitSHA`s. SHAs outside the allowlist are rejected with
//     `isError: true` and the underlying `git` process is never invoked.
//   - A single terminal tool `recordGateVerdict` validated against
//     `gateVerdictSchema`. On success the helper's Promise resolves with
//     the validated verdict; the orchestrator (5d-gate-level) then folds
//     it into `run.gateVerdicts` with the orchestrator-owned `round`
//     stamp.
//
// Scope: spec.md does not require mutation testing or a `validate-fix`
// mechanism, so the gate verdict's argument schema does NOT include the
// prose skill's `validation` / `skipped-validation` fields. See
// `critic-types.ts` for the schema commentary and the task notes for the
// scope reasoning.

import { spawn } from "node:child_process";

import {
  createAgent,
  tool,
  type Agent,
  type AgentTool,
  fromToolRunner,
} from "@intx/agent";
import type { Dependencies } from "@intx/inference";
import { type } from "arktype";
import {
  createPosixTools,
  type Middleware,
  type ToolHandler,
} from "@intx/tools-posix";
import type { ProviderConfig, ToolDefinition, ToolResult } from "@intx/types/runtime";

import { toolInputSchema } from "../json-schema-fixup.js";
import { createPathEscapeMiddleware } from "../path-escape.js";
import { terminalTool } from "../terminal-tool.js";
import {
  gateVerdictSchema,
  type GateCriticVerdict,
} from "./critic-types.js";

const READ_TOOL_NAMES = new Set(["read_file", "grep", "search_files"]);

const DEFAULT_SYSTEM_PROMPT = [
  "You are the per-level gate critic.",
  "",
  "The seed message you received contains, per task in this level: the plan body, the implementer's output.yaml, the per-task critic's verdict, and the committed SHA. Use the seed for the contract — do not search the filesystem for plan.md / output.yaml / verdict.yaml. You can also call `gitShow` with the commit SHA of any task in this level to inspect the diff that landed on the integration branch.",
  "",
  "When you have enough evidence, call the `recordGateVerdict` terminal tool exactly once. Its arguments are:",
  "  - `level`: the integer level you are gating.",
  "  - `status`: 'pass' if every task in the level is acceptable, 'amend' if at least one task has blocking findings the implementer(s) should fix, 'fail' for unrecoverable defects.",
  "  - `perTask`: a map keyed by task id with each entry { status, findings }. Every task in the level must appear.",
  "",
  "You have no write tools, no general shell tools, and no ability to read commits outside this level's allowlist. Read-only is your entire surface.",
  "",
  "OPERATING DISCIPLINE:",
  "  - CRITICAL: enumerating per-task findings in your `thinking` block IS NOT the same as recording a gate verdict. Every conclusion you reach in thinking MUST be emitted via the `recordGateVerdict` tool call in the SAME assistant message, before you stop. If your turn ends with only thinking and no tool call, you have failed: the reactor will close, the orchestrator will hang waiting for a verdict that will never come, and the entire run aborts. After analyzing the level, immediately call `recordGateVerdict` — do not produce a 'now I will summarize' turn.",
  "  - If you find yourself wanting to say 'I will now record the gate verdict' or 'let me call recordGateVerdict next' — stop talking and ACTUALLY emit the tool call. There is no follow-up turn unless the runtime gives you one in response to a tool call.",
  "  - The seed has everything you need. Spend your evidence-gathering budget on `gitShow` for diffs you want to double-check, not on file searches; the per-task plans / outputs / critic verdicts are already inlined.",
].join("\n");

export interface PerTaskGateCriticInput {
  readonly taskId: string;
  readonly planPath: string;
  readonly outputPath: string;
  readonly verdictPath: string;
  readonly commitSHA: string | null;
}

export interface CreateGateCriticAgentOptions {
  /**
   * Absolute path to the run directory (`dispatch/<run>/`). Used as the
   * posix tools' `cwd` and the path-escape middleware's `root` so the
   * agent can read per-task `plan.md`, `output.yaml`, and `verdict.yaml`.
   */
  readonly runDir: string;
  /**
   * Absolute path to the run's target repository — the working tree the
   * integration branch lives in. `gitShow` runs with this as its `cwd`;
   * it is NOT reachable via the posix read tools (those are confined to
   * `runDir`). The gate critic can only observe this repo through the
   * vetted `gitShow` surface.
   */
  readonly targetRepoPath: string;
  /** Integer level being gated. Surfaced for the orchestrator. */
  readonly level: number;
  /** All task ids in scope for this level. */
  readonly taskIds: readonly string[];
  /** Per-task inputs: paths and commit SHAs (commit may be null pre-commit). */
  readonly perTaskInputs: readonly PerTaskGateCriticInput[];
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
   * Optional provider name. Defaults to "anthropic". Override when wiring
   * to a different upstream.
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

export interface GateCriticAgent {
  readonly agent: Agent;
  /**
   * Resolves when the gate critic calls `recordGateVerdict` with valid
   * arguments. The orchestrator awaits this in parallel with the agent's
   * reactor loop and calls `agent.close()` once it resolves.
   */
  readonly awaitGateVerdict: Promise<GateCriticVerdict>;
}

export async function createGateCriticAgent(
  options: CreateGateCriticAgentOptions,
): Promise<GateCriticAgent> {
  const surface = buildGateCriticTools({
    runDir: options.runDir,
    targetRepoPath: options.targetRepoPath,
    perTaskInputs: options.perTaskInputs,
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
    awaitGateVerdict: surface.awaitGateVerdict,
  };
}

interface GateCriticToolBundle {
  readonly agentTools: AgentTool[];
  readonly awaitGateVerdict: Promise<GateCriticVerdict>;
}

/**
 * Exported for tests so the tool surface can be exercised against direct
 * `ToolCall` invocations without spinning up `createAgent`. Production
 * callers should use `createGateCriticAgent`.
 */
export function buildGateCriticTools(
  options: Pick<
    CreateGateCriticAgentOptions,
    "runDir" | "targetRepoPath" | "perTaskInputs"
  > & {
    /**
     * Test-only injection point for the git executor. Default runs the
     * real `git show <sha>` binary; tests pass a stub that returns
     * canned output so the test suite does not require a real repo.
     */
    readonly gitExecutor?: GitExecutor;
  },
): GateCriticToolBundle {
  const readTools = buildReadOnlyPosixTools(options.runDir);

  const allowedSHAs = new Set<string>();
  for (const entry of options.perTaskInputs) {
    if (entry.commitSHA !== null) allowedSHAs.add(entry.commitSHA);
  }

  const gitShow = buildGitShowTool({
    targetRepoPath: options.targetRepoPath,
    allowedSHAs,
    executor: options.gitExecutor ?? defaultGitExecutor,
  });

  const verdict = terminalTool("recordGateVerdict", gateVerdictSchema);

  return {
    agentTools: [...readTools, gitShow, verdict.tool],
    awaitGateVerdict: verdict.awaitTermination(),
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

const gitShowArgsSchema = type({
  sha: "string",
});

/**
 * Result shape returned by the git executor. `stdout` carries the patch
 * (or any other diagnostic git produced) that the tool surfaces back to
 * the model. `exitCode` non-zero is treated as an error and surfaced as
 * `isError: true`.
 */
export interface GitShowResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type GitExecutor = (args: {
  readonly sha: string;
  readonly cwd: string;
}) => Promise<GitShowResult>;

function buildGitShowTool(opts: {
  readonly targetRepoPath: string;
  readonly allowedSHAs: ReadonlySet<string>;
  readonly executor: GitExecutor;
}): AgentTool {
  return tool({
    definition: {
      name: "gitShow",
      description:
        "Read-only. Returns the output of `git show <sha>` against the run's target repository. `sha` MUST be one of the commit SHAs the orchestrator assigned to a task in this level; any other value is rejected without invoking git.",
      inputSchema: toolInputSchema(gitShowArgsSchema),
    },
    handler: async (call) => {
      const parsed = gitShowArgsSchema(call.arguments);
      if (parsed instanceof type.errors) {
        return errorResult(call.id, parsed.summary);
      }
      if (!opts.allowedSHAs.has(parsed.sha)) {
        return errorResult(
          call.id,
          `gitShow rejected: sha "${parsed.sha}" is not in this level's allowlist`,
        );
      }
      const result = await opts.executor({
        sha: parsed.sha,
        cwd: opts.targetRepoPath,
      });
      if (result.exitCode !== 0) {
        return errorResult(
          call.id,
          `git show ${parsed.sha} exited ${String(result.exitCode)}: ${result.stderr}`,
        );
      }
      return { callId: call.id, content: result.stdout };
    },
  });
}

function errorResult(callId: string, message: string): ToolResult {
  return { callId, content: message, isError: true };
}

const defaultGitExecutor: GitExecutor = ({ sha, cwd }) => {
  return new Promise<GitShowResult>((resolve, reject) => {
    const child = spawn("git", ["show", sha], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
};

export {
  gateVerdictSchema,
  perTaskGateVerdictSchema,
  findingSchema,
  type GateCriticVerdict,
  type PerTaskCriticGateVerdict,
  type CriticFinding,
} from "./critic-types.js";
export { DEFAULT_SYSTEM_PROMPT as GATE_CRITIC_DEFAULT_SYSTEM_PROMPT };
