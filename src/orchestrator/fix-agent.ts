// Fix-agent factory.
//
// A "fix agent" is an implementer that has been re-entered onto a task
// whose commit has been critiqued and found amendable. The brief
// (spec.md §588-§610) is explicit that:
//
//   1. The fix agent's tool surface is IDENTICAL to the implementer's —
//      file edits inside a worktree, no git capability. State changes
//      happen only via files; the orchestrator rebuilds commits.
//   2. The only thing that differs is the seed message: the fix agent
//      receives the per-task critique findings, the task's original
//      `plan.md`, and the committed diff (e.g. `git show <commitSHA>`)
//      so it can target its edits at the blocking findings rather than
//      starting from scratch.
//
// Because the surface is identical, this module deliberately does NOT
// reimplement the implementer. It composes `createImplementerAgent` with
// a seed message and exposes the same handle (`agent`,
// `awaitSubmitOutput`, `recordedBuilds`) plus the seed string so the
// orchestrator can drive `agent.send(seedMessage)` itself.
//
// The PoC scope: this module does not own the rebuild; once the fix
// agent submits, the amendment loop hands off to the rebuild callback
// (delegated from `5c-commit-level`).

import {
  createImplementerAgent,
  type CreateImplementerAgentOptions,
  type ImplementerAgent,
} from "../agents/implementer.js";
import type { Finding } from "../state/index.js";

export interface CreateFixAgentOptions extends CreateImplementerAgentOptions {
  /**
   * The blocking findings the fix agent must address. Surfaced verbatim in
   * the seed message so the model sees exactly what the critic reported.
   */
  readonly findings: readonly Finding[];
  /**
   * The task's original `plan.md` body. The fix agent re-reads the plan to
   * ground its edits in the original objective rather than only the
   * findings.
   */
  readonly taskPlanMarkdown: string;
  /**
   * Diff text for the commit the critique flagged. Production callers
   * obtain this via `git show <commitSHA>`; tests pass a canned string.
   * The fix agent uses it to understand what landed and what to amend.
   */
  readonly committedDiff: string;
  /** Identifier of the task being amended; included in the seed for clarity. */
  readonly taskId: string;
}

export interface FixAgent extends ImplementerAgent {
  /**
   * The seed message the orchestrator should `send` to the fix agent's
   * underlying implementer agent. Returned (rather than auto-sent) so the
   * orchestrator owns the `send`/`close` lifecycle exactly like it does
   * for any other implementer.
   */
  readonly seedMessage: string;
}

export async function createFixAgent(
  options: CreateFixAgentOptions,
): Promise<FixAgent> {
  const { findings, taskPlanMarkdown, committedDiff, taskId, ...implOpts } =
    options;
  const implementer = await createImplementerAgent(implOpts);
  const seedMessage = buildFixAgentSeed({
    taskId,
    findings,
    taskPlanMarkdown,
    committedDiff,
  });
  return {
    ...implementer,
    seedMessage,
  };
}

/**
 * Build the seed message handed to the fix agent. The message is
 * deliberately structured (sections separated by markdown headers) so the
 * model has unambiguous boundaries between findings, plan, and diff.
 *
 * Exported for tests so the message shape is asserted directly.
 */
export function buildFixAgentSeed(input: {
  readonly taskId: string;
  readonly findings: readonly Finding[];
  readonly taskPlanMarkdown: string;
  readonly committedDiff: string;
}): string {
  const findingsBlock = input.findings.length === 0
    ? "(no findings; the orchestrator should not have spawned a fix agent here)"
    : input.findings.map(renderFinding).join("\n\n");
  return [
    `You are amending task "${input.taskId}" in response to a critic's blocking findings.`,
    "",
    "Your tool surface is identical to the implementer's. You have no git capability; edit files inside the worktree and call `submitOutput` exactly once when finished. The orchestrator rebuilds commits from your edits.",
    "",
    "## Blocking findings",
    "",
    findingsBlock,
    "",
    "## Original plan.md",
    "",
    input.taskPlanMarkdown,
    "",
    "## Committed diff",
    "",
    "```",
    input.committedDiff,
    "```",
  ].join("\n");
}

function renderFinding(finding: Finding): string {
  const lineRange = finding.lineRange === null
    ? ""
    : ` (lines ${String(finding.lineRange[0])}-${String(finding.lineRange[1])})`;
  const filePath = finding.filePath === null ? "" : ` in ${finding.filePath}${lineRange}`;
  return `- [${finding.severity}] ${finding.id}${filePath}: ${finding.description}`;
}
