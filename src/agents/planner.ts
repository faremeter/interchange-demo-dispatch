// Planner agent role.
//
// Turns a free-form spec markdown file plus the target repo's skill-file
// blob into a validated, fully-leveled task DAG. The agent's only state-
// changing surface is two tools:
//
//   - `proposeTask` (repeatable). Validated against `proposeTaskArgsSchema`.
//     On success the runtime accumulates the proposal and returns
//     `{ ok: true, id }` so the model knows which generated id to depend on
//     in subsequent proposals. On argument-validation failure or runtime
//     rejection (duplicate idHint, dangling dependency referenced by id) the
//     tool returns `isError: true` carrying the reason; the model can retry.
//
//   - `finalizePlan` (terminal). Runs `validateDAG` over every accepted
//     proposal. On success the helper's Promise resolves with the
//     `FinalizedPlan` (tasks plus computed levels) and the orchestrator
//     closes the agent. On failure the tool returns `isError: true` carrying
//     the validation issues; the Promise stays unresolved so the model can
//     correct via more `proposeTask` calls before retrying.
//
// Read-side posix tools are exposed via `createPosixTools` with the
// path-escape middleware bolted on. Only the read tools (read_file, grep,
// search_files) reach the agent — the write/edit/shell tools live in the
// underlying runner but are never advertised, so the model has no way to
// invoke them.

import { type } from "arktype";

import {
  createAgent,
  type Agent,
  type AgentTool,
  fromToolRunner,
  tool,
} from "@intx/agent";

import { toolInputSchema } from "../json-schema-fixup.js";
import {
  createPosixTools,
  type Middleware,
  type ToolHandler,
} from "@intx/tools-posix";
import type { ProviderConfig, ToolDefinition, ToolResult } from "@intx/types/runtime";

import { createPathEscapeMiddleware } from "../path-escape";
import type { SkillFileBlob } from "../skill-loader";
import { validateDAG, type ProposedTask } from "../dag-validate";
import {
  finalizePlanArgsSchema,
  proposeTaskArgsSchema,
  type FinalizedPlan,
  type ProposedTaskRecord,
} from "./planner-types";

const READ_TOOL_NAMES = new Set([
  "read_file",
  "grep",
  "search_files",
]);

const DEFAULT_SYSTEM_PROMPT = [
  "You are the dispatch planner.",
  "",
  "Your job is to turn the spec the operator handed you, plus the bundled skill-file blob (which carries the target repository's AGENTS.md, CONVENTIONS.md, README.md, and every non-dispatch SKILL.md), into a directed acyclic graph of tasks the orchestrator can execute.",
  "",
  "Submit one task at a time via the `proposeTask` tool. Each proposal must include:",
  "  - `idHint`: short kebab-case slug; the runtime expands this into a unique task id.",
  "  - `level`: 1 for tasks with no dependencies; otherwise 1 + max(level of declared dependencies).",
  "  - `dependsOn`: ids of previously-proposed tasks this one builds on. Use the id returned by the previous `proposeTask` call.",
  "  - `objective`: one sentence describing what the task accomplishes.",
  "  - `planMarkdown`: the FULL multi-section plan body the implementer / critic / greybeard agents will receive as their seed. Treat this as the load-bearing field: downstream agents see only this text and the one-sentence objective. Include an Objective section, Requirements Covered, Context, Files to Modify, Constraints, Verification, Deviation Reporting, Subagent Responsibility, and Output Contract. Minimum 200 characters; aim for substantially more.",
  "  - `agentType`: `intern` for narrow mechanical tasks, `general` for tasks needing judgement, `explore` for read-only investigation.",
  "  - `class`: `feature` or `bugfix`.",
  "  - `verifyCommands`: array of shell commands the orchestrator should run to verify this task. An empty array means inherit the run-level build gate.",
  "  - `critiqueEnabled`: hint only. The runtime overrides this per role (general always critiqued, intern critiqued by default, explore never).",
  "",
  "Once every task has been proposed, call `finalizePlan` with no arguments. The runtime validates the accumulated DAG (acyclic, unique ids, levels consistent with deps) and refuses on failure — the refusal lists the issues so you can propose corrections.",
  "",
  "You have read-only filesystem tools (read_file, grep, search_files) scoped to the target repository. You have no write tools; the only way you change the run is via `proposeTask` and `finalizePlan`.",
  "",
  "OPERATING DISCIPLINE:",
  "  - Read at most 3-5 files to understand the repo, then START PROPOSING. Do not over-explore; the spec is your contract, not the existing code.",
  "  - After every read or search, ask: 'do I now have enough to propose the next task?' If yes, call `proposeTask`. Reading without proposing burns turn budget and risks the reactor closing before you finalize.",
  "  - `finalizePlan` is mandatory. A run with zero proposals or an unfinalized DAG is a wasted dispatch. If you are unsure about a detail, propose your best guess for the task — the implementer can adjust within its plan; you cannot recover a planner that never finalized.",
].join("\n");

export interface PlannerAgentOptions {
  readonly specPath: string;
  readonly skillBlob: SkillFileBlob;
  readonly targetRepoPath: string;
  readonly contextDir: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly provider?: string;
  readonly systemPrompt?: string;
  /** Override the seed message. When omitted, built from spec + skill blob. */
  readonly seedMessage?: string;
}

export interface CreatePlannerAgentResult {
  readonly agent: Agent;
  readonly awaitFinalizedPlan: Promise<FinalizedPlan>;
}

export async function createPlannerAgent(
  options: PlannerAgentOptions,
): Promise<CreatePlannerAgentResult> {
  const tools = buildPlannerTools(options);

  const providerConfig: ProviderConfig = {
    provider: options.provider ?? "openai",
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    model: options.model,
  };

  const agent = await createAgent({
    contextDir: options.contextDir,
    providers: [providerConfig],
    defaultModel: options.model,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    tools: tools.agentTools,
  });

  return {
    agent,
    awaitFinalizedPlan: tools.awaitFinalizedPlan,
  };
}

interface PlannerToolBundle {
  readonly agentTools: AgentTool[];
  readonly awaitFinalizedPlan: Promise<FinalizedPlan>;
}

/**
 * Exported for tests so the tool surface can be exercised against a mock
 * driver without spinning up `createAgent`. Production callers should use
 * `createPlannerAgent`.
 */
export function buildPlannerTools(
  options: Pick<PlannerAgentOptions, "targetRepoPath">,
): PlannerToolBundle {
  const readPosixTools = buildReadOnlyPosixTools(options.targetRepoPath);

  let resolveFinalized!: (plan: FinalizedPlan) => void;
  const finalizedPromise = new Promise<FinalizedPlan>((resolve) => {
    resolveFinalized = resolve;
  });

  const proposals: ProposedTaskRecord[] = [];
  const usedIds = new Set<string>();
  let finalized = false;

  const proposeTool = makePropose(proposals, usedIds, () => finalized);
  const finalizeTool = makeFinalize(
    proposals,
    () => finalized,
    (plan) => {
      finalized = true;
      resolveFinalized(plan);
    },
  );

  return {
    agentTools: [...readPosixTools, proposeTool, finalizeTool],
    awaitFinalizedPlan: finalizedPromise,
  };
}

function buildReadOnlyPosixTools(targetRepoPath: string): AgentTool[] {
  const posix = createPosixTools({ cwd: targetRepoPath });
  const escape = createPathEscapeMiddleware({ root: targetRepoPath });

  // The runner returned by createPosixTools has all six tools registered.
  // We do NOT pass write/edit/run_shell through `fromToolRunner`, so the
  // agent never sees their definitions and the model cannot invoke them.
  // We still wrap the runner in path-escape middleware so that even an
  // adversarial direct invocation (e.g. via a future plugin) cannot escape
  // the configured root.
  const escapedRun = wrapRunner(posix.run.bind(posix), escape);

  const readDefinitions: ToolDefinition[] = posix.definitions.filter((def) =>
    READ_TOOL_NAMES.has(def.name),
  );

  return fromToolRunner({
    definitions: readDefinitions,
    run: escapedRun,
  });
}

function wrapRunner(
  base: ToolHandler,
  middleware: Middleware,
): ToolHandler {
  const wrapped = middleware(base);
  return wrapped;
}

function makePropose(
  proposals: ProposedTaskRecord[],
  usedIds: Set<string>,
  isFinalized: () => boolean,
): AgentTool {
  return tool({
    definition: {
      name: "proposeTask",
      description:
        "Propose one task for the DAG. Repeatable. Returns the generated task id on success; returns isError on argument-validation or runtime-rejection (duplicate idHint, dangling dependency).",
      inputSchema: toolInputSchema(proposeTaskArgsSchema),
    },
    handler: async (call) => {
      if (isFinalized()) {
        return errorResult(
          call.id,
          "plan has already been finalized; further proposals are ignored",
        );
      }
      const parsed = proposeTaskArgsSchema(call.arguments);
      if (parsed instanceof type.errors) {
        return errorResult(call.id, parsed.summary);
      }

      const id = nextUniqueId(parsed.idHint, usedIds);

      const knownIds = new Set(proposals.map((p) => p.id));
      const danglingDeps = parsed.dependsOn.filter((dep) => !knownIds.has(dep));
      if (danglingDeps.length > 0) {
        return errorResult(
          call.id,
          `dependsOn references task id(s) not yet proposed: ${danglingDeps
            .map((d) => `"${d}"`)
            .join(", ")}. Propose them first, or correct the ids.`,
        );
      }

      usedIds.add(id);
      proposals.push({
        idHint: parsed.idHint,
        id,
        level: parsed.level,
        dependsOn: [...parsed.dependsOn],
        objective: parsed.objective,
        planMarkdown: parsed.planMarkdown,
        agentType: parsed.agentType,
        class: parsed.class,
        verifyCommands: [...parsed.verifyCommands],
        critiqueEnabled: parsed.critiqueEnabled,
      });

      return {
        callId: call.id,
        content: `accepted: id="${id}"`,
      };
    },
  });
}

function makeFinalize(
  proposals: readonly ProposedTaskRecord[],
  isFinalized: () => boolean,
  onSuccess: (plan: FinalizedPlan) => void,
): AgentTool {
  return tool({
    definition: {
      name: "finalizePlan",
      description:
        "Terminal. Validates the accumulated DAG (acyclic, unique ids, levels consistent with deps) and finalizes the plan. Returns isError with validation issues on failure; the model should then propose corrections before retrying.",
      inputSchema: toolInputSchema(finalizePlanArgsSchema),
    },
    handler: async (call) => {
      if (isFinalized()) {
        return errorResult(
          call.id,
          "plan already finalized; the orchestrator should have closed this agent",
        );
      }
      const parsed = finalizePlanArgsSchema(call.arguments);
      if (parsed instanceof type.errors) {
        return errorResult(call.id, parsed.summary);
      }

      if (proposals.length === 0) {
        return errorResult(
          call.id,
          "no tasks have been proposed; a plan must contain at least one task",
        );
      }

      const forValidator: ProposedTask[] = proposals.map((p) => ({
        id: p.id,
        level: p.level,
        dependsOn: p.dependsOn,
      }));
      const result = validateDAG(forValidator);
      if (!result.ok) {
        return errorResult(
          call.id,
          `DAG validation failed:\n- ${result.issues.join("\n- ")}`,
        );
      }

      onSuccess({ tasks: [...proposals], levels: result.levels });
      return {
        callId: call.id,
        content: "ok",
      };
    },
  });
}

function nextUniqueId(idHint: string, usedIds: ReadonlySet<string>): string {
  if (!usedIds.has(idHint)) return idHint;
  let n = 2;
  while (usedIds.has(`${idHint}-${String(n)}`)) n++;
  return `${idHint}-${String(n)}`;
}

function errorResult(callId: string, message: string): ToolResult {
  return { callId, content: message, isError: true };
}

/**
 * Compose the seed message a planner agent receives on its first turn.
 * Exported so the orchestrator can persist exactly what it sent for
 * resume-time drift detection.
 */
export function buildPlannerSeedMessage(args: {
  readonly specText: string;
  readonly specPath: string;
  readonly skillBlob: SkillFileBlob;
}): string {
  const parts: string[] = [];
  parts.push(`# Spec (${args.specPath})\n\n${args.specText}`);
  parts.push(
    `# Target-repo skill files (${String(args.skillBlob.files.length)} files, ${String(args.skillBlob.totalBytes)} bytes)\n\n${args.skillBlob.blob}`,
  );
  if (args.skillBlob.missingOptional.length > 0) {
    parts.push(
      `# Missing optional top-level files\n\n${args.skillBlob.missingOptional.join("\n")}`,
    );
  }
  return parts.join("\n\n---\n\n");
}

// Re-export for downstream consumers that import the planner-types via the
// agents/planner module surface.
export type { FinalizedPlan, ProposedTaskRecord } from "./planner-types";
export { DEFAULT_SYSTEM_PROMPT as PLANNER_DEFAULT_SYSTEM_PROMPT };
