// Phase-5 attribution agent.
//
// When the Phase-5 build comparison finds new failures that did not
// exist in the baseline, an attribution agent maps each failure to
// the responsible task(s). The agent is read-only: it has two
// terminal-style tools, `recordAttribution` (repeatable) and
// `finalizeAttribution` (terminal), wired through `terminalTool`'s
// promise contract.
//
// The agent's tool surface is deliberately minimal — the orchestrator
// pre-renders all the evidence (baseline log, final log, per-task
// output.yaml, per-task `git show <commitSHA>`) into the seed message
// so the agent does not need filesystem access. This keeps the
// attribution step deterministic in the sense that "what the agent
// reads" is fully controlled by the orchestrator, not by the
// agent's own tool calls. (spec.md §521-§534.)
//
// Following the same agent-handle pattern as `karen-loop.ts`'s
// `GreybeardAgentHandle` and `run-level.ts`'s
// `ImplementerAgentHandle`, this module exposes
// `AttributionAgentHandle` so tests can stub `send` / `close` without
// having to implement the full `@intx/agent` `Agent` shape.

import {
  createAgent,
  type Agent,
  type AgentTool,
  tool,
} from "@intx/agent";
import { type } from "arktype";
import type { ProviderConfig } from "@intx/types/runtime";

import { toolInputSchema } from "../../json-schema-fixup.js";
import { terminalTool } from "../../terminal-tool.js";

const ATTRIBUTION_SYSTEM_PROMPT = [
  "You are the Phase 5 attribution agent.",
  "",
  "Each input you receive identifies one or more 'new build failures' that appear in the final build log but not in the baseline. For every failure, your job is to decide which task(s) in the run are responsible.",
  "",
  "Tools:",
  "  - `recordAttribution({ failureId, taskIds })` — call once per failure. `failureId` is a string identifier from the new-failure list; `taskIds` is a non-empty array of task ids you believe are responsible.",
  "  - `finalizeAttribution()` — call exactly once at the end, after every failure has a `recordAttribution` entry, to signal that you are done.",
  "",
  "You have no file system access and no shell. All evidence you need (baseline log, final log, per-task plan / output / committed diff) is embedded in this conversation.",
].join("\n");

export const recordAttributionArgsSchema = type({
  failureId: "string",
  taskIds: "string[] >= 1",
});

export type RecordAttributionArgs = typeof recordAttributionArgsSchema.infer;

export const finalizeAttributionArgsSchema = type({});

export type FinalizeAttributionArgs = typeof finalizeAttributionArgsSchema.infer;

export interface AttributionResult {
  /**
   * `failureId -> taskIds[]`. The orchestrator validates that every
   * failure id in the input set appears as a key and that every task
   * id is present in the current run.
   */
  readonly attribution: Record<string, string[]>;
}

/**
 * Minimal agent surface the orchestrator needs from an attribution
 * agent handle. Production code (`createAttributionAgent`) returns a
 * full `@intx/agent` `Agent` which satisfies this structurally; tests
 * provide a stub with `send` and `close` only. Mirrors
 * `GreybeardAgentHandle` / `ImplementerAgentHandle`.
 */
export interface AttributionAgentHandle {
  send(content: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface CreateAttributionAgentOptions {
  /**
   * Absolute path to the agent's private context directory; MUST be
   * unique per agent (the `@intx/agent` lock enforces it).
   */
  readonly contextDir: string;
  /** Model identifier passed to the provider config. */
  readonly model: string;
  /** Provider base URL. */
  readonly baseURL: string;
  /** Provider API key. */
  readonly apiKey: string;
  /** Optional provider name (defaults to "anthropic"). */
  /** Inference adapter (e.g. "openai", "anthropic"). Required. */
  readonly adapter: string;
  /** Optional system-prompt override. */
  readonly systemPrompt?: string;
}

export interface AttributionAgent {
  readonly agent: Agent;
  /**
   * Resolves with the agent's accumulated attribution map once it
   * calls `finalizeAttribution`. The orchestrator awaits this in
   * parallel with the reactor loop and closes the agent on resolution.
   */
  readonly awaitAttribution: Promise<AttributionResult>;
}

export async function createAttributionAgent(
  options: CreateAttributionAgentOptions,
): Promise<AttributionAgent> {
  const surface = buildAttributionTools();

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
    systemPrompt: options.systemPrompt ?? ATTRIBUTION_SYSTEM_PROMPT,
    tools: surface.agentTools,
  });

  return {
    agent,
    awaitAttribution: surface.awaitAttribution,
  };
}

interface AttributionToolBundle {
  readonly agentTools: AgentTool[];
  readonly awaitAttribution: Promise<AttributionResult>;
}

/**
 * Build the attribution agent's tool surface in isolation from
 * `createAgent`. Exported so tests can drive the surface directly
 * with synthetic `ToolCall`s instead of standing up a real agent.
 */
export function buildAttributionTools(): AttributionToolBundle {
  const sink = new Map<string, string[]>();
  const recordTool = buildRecordTool(sink);
  const finalize = terminalTool(
    "finalizeAttribution",
    finalizeAttributionArgsSchema,
  );
  const awaitAttribution = finalize.awaitTermination().then(() => {
    const attribution: Record<string, string[]> = {};
    const keys = Array.from(sink.keys()).sort();
    for (const k of keys) {
      const list = sink.get(k);
      if (list === undefined) {
        throw new Error(`internal: attribution sink missing entry for ${k}`);
      }
      attribution[k] = [...list];
    }
    return { attribution } satisfies AttributionResult;
  });

  return {
    agentTools: [recordTool, finalize.tool],
    awaitAttribution,
  };
}

function buildRecordTool(sink: Map<string, string[]>): AgentTool {
  return tool({
    definition: {
      name: "recordAttribution",
      description:
        "Map a single new build failure to one or more responsible tasks. Required fields: failureId (string, must match an id from the input list); taskIds (string[], non-empty). Call once per failure; the orchestrator dedupes repeated taskIds within a call.",
      inputSchema: toolInputSchema(recordAttributionArgsSchema),
    },
    handler: async (call) => {
      const parsed = recordAttributionArgsSchema(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          content: parsed.summary,
          isError: true,
        };
      }
      const deduped = dedupePreservingOrder(parsed.taskIds);
      sink.set(parsed.failureId, deduped);
      return {
        callId: call.id,
        content: "recorded",
      };
    },
  });
}

function dedupePreservingOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Render the orchestrator-side evidence package the attribution agent
 * consumes via its seed message. Exported so callers can construct
 * the seed deterministically (and tests can assert on it).
 *
 * The seed is a structured markdown document with these sections:
 *   - Baseline build log (full text)
 *   - Final build log (full text)
 *   - New failures (id + raw text)
 *   - Per-task evidence (plan, output.yaml, `git show` diff)
 */
export interface AttributionSeedInput {
  readonly baselineLog: string;
  readonly finalLog: string;
  readonly newFailures: readonly {
    readonly id: string;
    readonly message: string;
    readonly file: string | null;
    readonly line: number | null;
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly objective: string;
    readonly filesModified: readonly string[];
    readonly commitSHA: string | null;
    readonly committedDiff: string;
    readonly planMarkdown: string;
    readonly outputYAML: string;
  }[];
}

export function buildAttributionSeed(input: AttributionSeedInput): string {
  const sections: string[] = [];
  sections.push(
    "You are attributing new build failures to the task(s) responsible. Read the evidence below, then call `recordAttribution` once per failure and `finalizeAttribution` exactly once at the end.",
  );

  sections.push("## Baseline build log\n\n```\n" + input.baselineLog + "\n```");
  sections.push("## Final build log\n\n```\n" + input.finalLog + "\n```");

  const failureLines = input.newFailures.map((f) => {
    const loc = f.file === null
      ? ""
      : f.line === null
        ? ` (in ${f.file})`
        : ` (in ${f.file}:${String(f.line)})`;
    return `- ${f.id}${loc}: ${f.message}`;
  });
  sections.push(
    "## New failures (final - baseline)\n\n" +
      (failureLines.length === 0 ? "(none)" : failureLines.join("\n")),
  );

  const taskBlocks = input.tasks.map((t) => buildTaskEvidenceBlock(t));
  sections.push("## Per-task evidence\n\n" + taskBlocks.join("\n\n"));

  return sections.join("\n\n");
}

function buildTaskEvidenceBlock(task: {
  readonly id: string;
  readonly objective: string;
  readonly filesModified: readonly string[];
  readonly commitSHA: string | null;
  readonly committedDiff: string;
  readonly planMarkdown: string;
  readonly outputYAML: string;
}): string {
  const sha = task.commitSHA === null ? "(zero-file commit unit)" : task.commitSHA;
  const filesModified = task.filesModified.length === 0
    ? "(none)"
    : task.filesModified.map((f) => `  - ${f}`).join("\n");
  return [
    `### Task ${task.id}`,
    "",
    `Objective: ${task.objective}`,
    "",
    `commitSHA: ${sha}`,
    "",
    "filesModified:",
    filesModified,
    "",
    "#### plan.md",
    "",
    "```",
    task.planMarkdown,
    "```",
    "",
    "#### output.yaml",
    "",
    "```yaml",
    task.outputYAML,
    "```",
    "",
    "#### Committed diff",
    "",
    "```",
    task.committedDiff,
    "```",
  ].join("\n");
}

/**
 * Validate that an `AttributionResult` lines up with the orchestrator's
 * input: every failure id from `expectedFailureIds` must appear as a
 * key, no extra keys are allowed, and every task id mentioned must be
 * a member of `knownTaskIds`. Throws on mismatch — the orchestrator
 * treats this as an attribution-agent failure (escalation).
 */
export function validateAttributionResult(
  result: AttributionResult,
  expectedFailureIds: readonly string[],
  knownTaskIds: readonly string[],
): void {
  const expected = new Set(expectedFailureIds);
  const known = new Set(knownTaskIds);
  const got = new Set(Object.keys(result.attribution));

  const missing: string[] = [];
  for (const id of expectedFailureIds) {
    if (!got.has(id)) missing.push(id);
  }
  const extra: string[] = [];
  for (const id of got) {
    if (!expected.has(id)) extra.push(id);
  }
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `attribution result does not match expected failure ids; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`,
    );
  }

  for (const [failureId, taskIds] of Object.entries(result.attribution)) {
    if (taskIds.length === 0) {
      throw new Error(
        `attribution result for failure "${failureId}" has empty taskIds`,
      );
    }
    const unknownTaskIds = taskIds.filter((t) => !known.has(t));
    if (unknownTaskIds.length > 0) {
      throw new Error(
        `attribution result for failure "${failureId}" references unknown task ids: ${unknownTaskIds.join(", ")}`,
      );
    }
  }
}
