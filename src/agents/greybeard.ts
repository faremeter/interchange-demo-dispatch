// Greybeard agent role factory.
//
// Karen consults the greybeard once per `moderate`-severity deviation a task
// reports through `submitOutput`. The greybeard reads the task's plan,
// output, and the uncommitted worktree, then calls `recordGreybeardVerdict`
// with `accept` / `reject` / `escalate` plus a one-paragraph rationale. The
// orchestrator (5b-run-level) feeds the verdict to
// `karenProcessGreybeardVerdict` and dispatches the resulting
// `KarenFinalAction`.
//
// Tool surface (intentionally narrow):
//
//   - Read-only posix tools (`read_file`, `grep`, `search_files`) confined to
//     the task's worktree via `createPathEscapeMiddleware`.
//   - Two specific files outside the worktree are reachable via Read: the
//     task's `plan.md` and `output.yaml`. The path-escape middleware shipped
//     in `src/path-escape.ts` only takes a single `root`, so this factory
//     composes around it: `makeBypassOrEscapeHandler` resolves each call's
//     path argument with `realpath`, dispatches to the BASE handler when
//     the resolved path matches one of the allowlisted out-of-root files,
//     and otherwise dispatches through the path-escape-wrapped handler.
//     We compose around the existing middleware rather than modifying it.
//   - The terminal tool `recordGreybeardVerdict`, validated against
//     `greybeardVerdictPayloadSchema`.
//
// Recursion prevention: the agent has NO tool that could spawn another
// greybeard (no `consultGreybeard`, no write/edit/run_shell, no recursive
// `createGreybeardAgent` exposed to the model). The orchestrator does not
// nest greybeard calls; this factory does not provide a surface that could
// be misused to do so.

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  createAgent,
  fromToolRunner,
  type Agent,
  type AgentTool,
} from "@intx/agent";
import {
  createPosixTools,
  type ToolHandler,
} from "@intx/tools-posix";
import type {
  ProviderConfig,
  ReactorDirector,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@intx/types/runtime";
import type { Dependencies } from "@intx/inference";

import type { Deviation } from "../state/types.js";
import { createPathEscapeMiddleware } from "../path-escape.js";
import { terminalTool } from "../terminal-tool.js";
import {
  greybeardVerdictPayloadSchema,
  type GreybeardVerdictPayload,
} from "./greybeard-types.js";

const READ_TOOL_NAMES = new Set(["read_file", "grep", "search_files"]);

const GREYBEARD_SYSTEM_PROMPT = [
  "You are the greybeard.",
  "",
  "Karen has asked you to rule on ONE deviation reported by an implementer task. Your verdict is one of:",
  "  - accept:   the deviation is harmless or correct; the task should be allowed to commit as-is.",
  "  - reject:   the deviation indicates incorrect or unsafe work; the task should be marked failed and re-dispatched.",
  "  - escalate: you cannot decide with the information available; punt to the human operator.",
  "",
  "Read the task's plan and output to understand the original mandate and what the implementer claims to have done. Use the read tools to inspect the worktree files the implementer touched. When you have enough context, call `recordGreybeardVerdict` exactly once with your verdict and a non-empty one-paragraph rationale.",
  "",
  "You have no write tools, no shell, and no way to call another agent. Your only outputs are the read tools (for inspection) and `recordGreybeardVerdict` (for the verdict).",
].join("\n");

export interface CreateGreybeardAgentOptions {
  /** Identifier of the task whose deviation is being reviewed. */
  taskId: string;
  /** The specific deviation Karen is asking about. */
  deviation: Deviation;
  /**
   * Absolute path to the task's `plan.md`. Lives outside the worktree; the
   * factory adds it to the path-escape bypass allowlist so the greybeard
   * can Read it.
   */
  planPath: string;
  /**
   * Absolute path to the task's `output.yaml`. Lives outside the worktree;
   * also added to the bypass allowlist.
   */
  outputPath: string;
  /**
   * Absolute path to the task's worktree. Used as both the posix tools'
   * `cwd` and the path-escape middleware's `root`.
   */
  worktreePath: string;
  /**
   * Absolute path to the agent's private isogit-backed context directory.
   * MUST be unique per agent invocation; nested greybeards are not
   * permitted, so callers must allocate a fresh directory per deviation.
   */
  contextDir: string;
  /** Model identifier passed through to the provider config. */
  model: string;
  /** Provider base URL. */
  baseURL: string;
  /** Provider API key. */
  apiKey: string;
  /**
   * Optional director override. Production callers leave this undefined.
   * Tests pass a scripted `ReactorDirector` so no real HTTP is issued.
   */
  director?: ReactorDirector;
  /**
   * Optional inference dependencies (e.g. a stub `fetch`). Production
   * callers leave this undefined.
   */
  deps?: Dependencies;
  /** Inference adapter (e.g. "openai", "anthropic"). Required. */
  adapter: string;
}

export interface GreybeardAgent {
  agent: Agent;
  /**
   * Resolves once the agent calls `recordGreybeardVerdict` with arguments
   * that pass schema validation. The orchestrator awaits this in parallel
   * with the agent's reactor loop and closes the agent on resolution.
   */
  awaitVerdict: Promise<GreybeardVerdictPayload>;
}

function buildGreybeardSeedMessage(
  taskId: string,
  deviation: Deviation,
  planPath: string,
  outputPath: string,
  worktreePath: string,
): string {
  const lines: string[] = [];
  lines.push(`# Greybeard consultation`);
  lines.push("");
  lines.push(`Task id: ${taskId}`);
  lines.push(`Plan path: ${planPath}`);
  lines.push(`Output path: ${outputPath}`);
  lines.push(`Worktree path: ${worktreePath}`);
  lines.push("");
  lines.push(`## Deviation under review`);
  lines.push("");
  lines.push(`- id: ${deviation.id}`);
  lines.push(`- severity: ${deviation.severity}`);
  lines.push(`- category: ${deviation.category}`);
  lines.push(`- description: ${deviation.description}`);
  if (deviation.affectedFiles.length > 0) {
    lines.push(`- affected files:`);
    for (const f of deviation.affectedFiles) lines.push(`    - ${f}`);
  } else {
    lines.push(`- affected files: (none reported)`);
  }
  lines.push("");
  lines.push(
    "Decide whether the deviation should be accepted, rejected, or escalated to the operator. Use the read tools to inspect the worktree, plan, and output if needed. Then call `recordGreybeardVerdict` with your verdict and a one-paragraph rationale.",
  );
  return lines.join("\n");
}

/**
 * Build the greybeard agent. The returned object exposes the live `Agent`
 * and an `awaitVerdict` Promise the orchestrator races against the reactor
 * loop. The orchestrator is responsible for sending the seed message and
 * closing the agent once the Promise resolves.
 *
 * The seed message returned by `buildGreybeardSeedMessage` is exported via
 * the result so the orchestrator can record exactly what was sent. The
 * factory itself does not call `agent.send`; that decoupling lets tests
 * drive the reactor with arbitrary first turns.
 */
export async function createGreybeardAgent(
  options: CreateGreybeardAgentOptions,
): Promise<GreybeardAgent> {
  const tools = buildGreybeardTools(options);

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
    systemPrompt: GREYBEARD_SYSTEM_PROMPT,
    tools: tools.agentTools,
    ...(options.director !== undefined ? { director: options.director } : {}),
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  });

  return {
    agent,
    awaitVerdict: tools.awaitVerdict,
  };
}

interface GreybeardToolBundle {
  agentTools: AgentTool[];
  awaitVerdict: Promise<GreybeardVerdictPayload>;
}

/**
 * Build the greybeard's tool surface without standing up an Agent. Exported
 * so tests can exercise the tools directly (no provider HTTP, no reactor)
 * and assert the surface excludes any recursion-enabling capability.
 */
export function buildGreybeardTools(
  options: Pick<
    CreateGreybeardAgentOptions,
    "worktreePath" | "planPath" | "outputPath"
  >,
): GreybeardToolBundle {
  const posix = createPosixTools({ cwd: options.worktreePath });

  // Compose around `createPathEscapeMiddleware` rather than modifying it:
  // build a top-level handler that resolves the call's path argument and
  // dispatches to the base handler directly when the path matches one of
  // the allowlisted out-of-root files (plan + output). Everything else
  // dispatches through the path-escape-wrapped handler, which confines
  // reads to the worktree.
  const escape = createPathEscapeMiddleware({ root: options.worktreePath });
  const base: ToolHandler = posix.run.bind(posix);
  const escaped: ToolHandler = escape(base);
  const handler: ToolHandler = makeBypassOrEscapeHandler(
    base,
    escaped,
    [options.planPath, options.outputPath],
  );

  const readDefinitions: ToolDefinition[] = posix.definitions.filter((def) =>
    READ_TOOL_NAMES.has(def.name),
  );

  const readTools = fromToolRunner({
    definitions: readDefinitions,
    run: handler,
  });

  const submit = terminalTool(
    "recordGreybeardVerdict",
    greybeardVerdictPayloadSchema,
  );

  // Sanity check the surface at construction time: no tool name on the
  // surface may suggest recursion. This is a defensive guard; the factory
  // never registers such a tool, but if a future change accidentally
  // exposed one this check would surface it loudly.
  const agentTools: AgentTool[] = [...readTools, submit.tool];
  assertNoRecursionTools(agentTools);

  return {
    agentTools,
    awaitVerdict: submit.awaitTermination(),
  };
}

/**
 * Build the composite handler. If the call's path argument resolves to one
 * of the allowlisted files, dispatch to the base handler directly (skipping
 * path-escape). Otherwise dispatch through the path-escape-wrapped handler.
 *
 * Notes:
 *
 * - Only the read tools have a `path` argument under the greybeard's
 *   surface; `run_shell` / `write_file` / `edit_file` are not advertised
 *   and would not reach this handler from the agent. The check is keyed by
 *   tool name so any unrecognized tool falls through to the path-escape
 *   path, which is the conservative default.
 *
 * - Path resolution uses `realpath` to defeat symlinks; ENOENT on the
 *   allowed file is treated as not-on-allowlist (the file should exist by
 *   the time the greybeard is consulted, but if it does not, the conservative
 *   path-escape handler will provide the rejection message).
 */
function makeBypassOrEscapeHandler(
  base: ToolHandler,
  escaped: ToolHandler,
  allowedFiles: readonly string[],
): ToolHandler {
  const PATH_ARG_KEYS: Record<string, readonly string[]> = {
    read_file: ["path"],
    grep: ["path"],
    search_files: ["path"],
  };

  const resolvedAllowed = new Set(
    allowedFiles.map((p) => {
      if (!isAbsolute(p)) {
        throw new Error(`allowlist entry must be an absolute path: ${p}`);
      }
      return realpathSync(p);
    }),
  );

  return async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
    const keys = PATH_ARG_KEYS[call.name];
    if (keys === undefined) return escaped(call, signal);

    // Each present path arg must resolve to an allowlisted file for the
    // bypass to trigger. Mixed calls (one allowed, one not) fall through
    // to path-escape so the disallowed one is rejected with the standard
    // path-escape message.
    let anyArgPresent = false;
    let allAllowed = true;
    for (const key of keys) {
      const value = call.arguments[key];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        allAllowed = false;
        break;
      }
      anyArgPresent = true;
      const abs = isAbsolute(value) ? value : resolve(process.cwd(), value);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        allAllowed = false;
        break;
      }
      if (!resolvedAllowed.has(real)) {
        allAllowed = false;
        break;
      }
    }

    if (anyArgPresent && allAllowed) {
      return base(call, signal);
    }
    return escaped(call, signal);
  };
}

const RECURSION_NAME_PATTERNS = [
  /greybeard/i,
  /consult/i,
  /spawn/i,
  /invoke.*agent/i,
];

function assertNoRecursionTools(tools: readonly AgentTool[]): void {
  for (const t of tools) {
    if (t.definition.name === "recordGreybeardVerdict") continue;
    for (const pat of RECURSION_NAME_PATTERNS) {
      if (pat.test(t.definition.name)) {
        throw new Error(
          `greybeard tool surface contains a recursion-suggesting tool name: "${t.definition.name}"`,
        );
      }
    }
  }
}

export { buildGreybeardSeedMessage, GREYBEARD_SYSTEM_PROMPT };
export type { GreybeardVerdictPayload } from "./greybeard-types.js";
export { greybeardVerdictPayloadSchema } from "./greybeard-types.js";
