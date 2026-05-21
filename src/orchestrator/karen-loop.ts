// Per-task Karen loop.
//
// For each `Deviation` an implementer reports through `submitOutput`:
//
//   1. Run `karenInitialAction(deviation)` to get one of
//      `accept` / `markFailed` / `consultGreybeard` / `escalateToOperator`.
//   2. Dispatch:
//        - `accept`             -> append to `decisions` and continue.
//        - `markFailed`         -> resolve loop with `failed` final state.
//        - `consultGreybeard`   -> spawn the greybeard agent for THIS
//                                  deviation, await its verdict, feed it
//                                  through `karenProcessGreybeardVerdict`,
//                                  then act on the resulting final action.
//        - `escalateToOperator` -> invoke the operator escape hatch; on
//                                  `continue`, append the decision and keep
//                                  iterating; on `abort`, resolve loop with
//                                  `aborted` final state.
//
// Deviations within a task are evaluated in declared order; the loop short-
// circuits as soon as a non-accept terminal arises (failed / aborted). This
// matches the spec's "any one fatal deviation fails the task" semantics.
//
// Recursion guard: the loop must NEVER consult the greybeard about a
// greybeard verdict. A `consultGreybeard` action arising from a final action
// processed via `karenProcessGreybeardVerdict` is impossible by construction
// — `KarenFinalAction` does not include `consultGreybeard`. The compiler
// enforces this, and a defensive `default` branch throws if the type system
// is ever bypassed.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Dependencies } from "@intx/inference";

import { drainAgentStream, type AgentTrace } from "../agent-trace.js";

import {
  karenInitialAction,
  karenProcessGreybeardVerdict,
  type GreybeardVerdict,
  type KarenFinalAction,
  type KarenInitialAction,
} from "../karen.js";
import {
  createGreybeardAgent,
  buildGreybeardSeedMessage,
  type CreateGreybeardAgentOptions,
} from "../agents/greybeard.js";
import type { Deviation, Task } from "../state/types.js";
import {
  awaitOperatorResolution,
  type OperatorResolution,
} from "./operator-escalation.js";

export type KarenLoopFinalState =
  | { kind: "accepted" }
  | { kind: "failed"; deviation: Deviation; reason: KarenFinalAction }
  | { kind: "aborted"; deviation: Deviation };

/**
 * One entry per deviation processed (including any short-circuit terminal).
 * Captured for diagnostics; the orchestrator writes this into per-task logs.
 */
export interface KarenDecisionRecord {
  deviationId: string;
  initial: KarenInitialAction;
  greybeard?: {
    verdict: GreybeardVerdict;
    rationale: string;
    final: KarenFinalAction;
  };
  operator?: OperatorResolution;
  outcome: "accepted" | "failed" | "aborted";
}

export interface KarenLoopResult {
  taskId: string;
  finalState: KarenLoopFinalState;
  decisions: KarenDecisionRecord[];
}

/**
 * Closure that, given the run directory + escalation context, returns the
 * operator's resolution. Production callers wire this to
 * `awaitOperatorResolution`; tests pass a deterministic stub.
 */
export type OperatorResolver = (input: {
  runDir: string;
  reason: string;
  details: Record<string, unknown>;
}) => Promise<OperatorResolution>;

export interface RunKarenLoopForTaskOptions {
  /** The task whose deviations are being processed. */
  task: Task;
  /** Deviations to evaluate, in declared order. */
  deviations: readonly Deviation[];
  /** Absolute path to the run directory (parent of `pending-escalation.yaml`). */
  runDir: string;
  /** Absolute path to the task's plan.md (for the greybeard's read allowlist). */
  planPath: string;
  /** Absolute path to the task's persisted output.yaml. */
  outputPath: string;
  /** Absolute path to the level worktree (the greybeard's confined root). */
  worktreePath: string;
  /**
   * Parent directory under which per-greybeard `agent-ctx/` directories are
   * allocated. Each consultation gets a fresh subdirectory; the loop creates
   * the directory before calling the spawner so the spawner's
   * `createGreybeardAgent` can pass it through to `@intx/agent` directly.
   */
  greybeardContextRoot: string;
  /** Provider model identifier (greybeard agent). */
  model: string;
  /** Provider base URL (greybeard agent). */
  baseURL: string;
  /** Provider API key (greybeard agent). */
  apiKey: string;
  /** Inference adapter (e.g. "openai", "anthropic"). Required. */
  adapter: string;
  /**
   * Inference-layer `Dependencies` forwarded to the greybeard agent
   * factory. Production callers leave this undefined; tests thread the
   * deterministic harness `deps` through so model calls are
   * intercepted.
   */
  readonly deps?: Dependencies;
  /**
   * Operator-facing sink for streamed agent activity. Forwarded into
   * `drainAgentStream` for the greybeard consultations Karen spawns.
   */
  readonly trace?: AgentTrace;
  /**
   * Optional injectable operator resolver; defaults to
   * `awaitOperatorResolution`. Tests inject a deterministic stub.
   */
  operatorResolver?: OperatorResolver;
  /** Poll interval forwarded to the default operator resolver. */
  operatorPollIntervalMs?: number;
  /** Timeout forwarded to the default operator resolver. */
  operatorTimeoutMs?: number;
}

/**
 * Drive Karen's per-task policy loop. See file header for the dispatch
 * table. Resolves with the loop's final state and a per-deviation decision
 * log. Throws only on unrecoverable infrastructure failures (the operator
 * file-watch timed out, the greybeard agent crashed, etc.); ordinary policy
 * outcomes (failed / aborted) come back as result fields.
 */
export async function runKarenLoopForTask(
  options: RunKarenLoopForTaskOptions,
): Promise<KarenLoopResult> {
  const decisions: KarenDecisionRecord[] = [];
  const operatorResolver =
    options.operatorResolver ?? buildDefaultOperatorResolver(options);

  for (const deviation of options.deviations) {
    const initial = karenInitialAction(deviation);
    const record: KarenDecisionRecord = {
      deviationId: deviation.id,
      initial,
      outcome: "accepted",
    };
    switch (initial) {
      case "accept": {
        decisions.push(record);
        continue;
      }
      case "markFailed": {
        record.outcome = "failed";
        decisions.push(record);
        return {
          taskId: options.task.id,
          finalState: { kind: "failed", deviation, reason: "markFailed" },
          decisions,
        };
      }
      case "consultGreybeard": {
        const final = await consultGreybeardAndProcess({
          deviation,
          task: options.task,
          options,
          record,
        });
        const followUp = await actOnFinalAction({
          final,
          deviation,
          options,
          operatorResolver,
          record,
        });
        decisions.push(record);
        if (followUp.kind !== "accepted") {
          return {
            taskId: options.task.id,
            finalState: followUp,
            decisions,
          };
        }
        continue;
      }
      case "escalateToOperator": {
        const followUp = await actOnFinalAction({
          final: "escalateToOperator",
          deviation,
          options,
          operatorResolver,
          record,
        });
        decisions.push(record);
        if (followUp.kind !== "accepted") {
          return {
            taskId: options.task.id,
            finalState: followUp,
            decisions,
          };
        }
        continue;
      }
      default: {
        const _exhaustive: never = initial;
        throw new Error(
          `runKarenLoopForTask: unrecognized Karen initial action: ${String(_exhaustive)}`,
        );
      }
    }
  }

  return {
    taskId: options.task.id,
    finalState: { kind: "accepted" },
    decisions,
  };
}

async function consultGreybeardAndProcess(args: {
  deviation: Deviation;
  task: Task;
  options: RunKarenLoopForTaskOptions;
  record: KarenDecisionRecord;
}): Promise<KarenFinalAction> {
  const { deviation, task, options, record } = args;
  const consultationDir = join(
    options.greybeardContextRoot,
    `${task.id}--${deviation.id}`,
  );
  await mkdir(consultationDir, { recursive: true });

  const spawnOptions: CreateGreybeardAgentOptions = {
    taskId: task.id,
    deviation,
    planPath: options.planPath,
    outputPath: options.outputPath,
    worktreePath: options.worktreePath,
    contextDir: consultationDir,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    adapter: options.adapter,
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  };
  const handle = await createGreybeardAgent(spawnOptions);
  // Drain the greybeard's event stream so `inference.error` events
  // (and, when wired, traced thinking / tool calls) reach the
  // operator. Closed in the finally below alongside the agent.
  const drain = drainAgentStream(
    handle.agent,
    `greybeard ${task.id}`,
    options.trace,
  );
  try {
    const seed = buildGreybeardSeedMessage(
      task.id,
      deviation,
      options.planPath,
      options.outputPath,
      options.worktreePath,
    );
    handle.agent.send(seed).catch((err: unknown) => {
      // The scripted director path naturally rejects send() with
      // AgentClosedError once the reactor shuts down. We surface only
      // unexpected errors; AgentClosedError is consumed by the lifecycle.
      const name =
        typeof err === "object" && err !== null && "name" in err
          ? String((err as { name: unknown }).name)
          : "";
      if (name === "AgentClosedError") return;
      throw err;
    });
    const verdict = await handle.awaitVerdict;
    const final = karenProcessGreybeardVerdict(verdict.verdict);
    record.greybeard = {
      verdict: verdict.verdict,
      rationale: verdict.rationale,
      final,
    };
    return final;
  } finally {
    await handle.agent.close();
    await drain;
  }
}

async function actOnFinalAction(args: {
  final: KarenFinalAction;
  deviation: Deviation;
  options: RunKarenLoopForTaskOptions;
  operatorResolver: OperatorResolver;
  record: KarenDecisionRecord;
}): Promise<KarenLoopFinalState> {
  const { final, deviation, options, operatorResolver, record } = args;
  switch (final) {
    case "accept":
      record.outcome = "accepted";
      return { kind: "accepted" };
    case "markFailed":
      record.outcome = "failed";
      return { kind: "failed", deviation, reason: "markFailed" };
    case "escalateToOperator": {
      const reason = buildEscalationReason(deviation, record);
      const details = buildEscalationDetails(deviation, record, options);
      const resolution = await operatorResolver({
        runDir: options.runDir,
        reason,
        details,
      });
      record.operator = resolution;
      if (resolution === "continue") {
        record.outcome = "accepted";
        return { kind: "accepted" };
      }
      record.outcome = "aborted";
      return { kind: "aborted", deviation };
    }
    default: {
      const _exhaustive: never = final;
      throw new Error(
        `runKarenLoopForTask: unrecognized Karen final action: ${String(_exhaustive)}`,
      );
    }
  }
}

function buildEscalationReason(
  deviation: Deviation,
  record: KarenDecisionRecord,
): string {
  if (record.greybeard !== undefined) {
    return `Karen + greybeard escalation: deviation ${deviation.id} (severity=${deviation.severity}) — greybeard verdict ${record.greybeard.verdict}: ${record.greybeard.rationale}`;
  }
  return `Karen direct escalation: deviation ${deviation.id} (severity=${deviation.severity}) — ${deviation.description}`;
}

function buildEscalationDetails(
  deviation: Deviation,
  record: KarenDecisionRecord,
  options: RunKarenLoopForTaskOptions,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    taskId: options.task.id,
    deviationId: deviation.id,
    severity: deviation.severity,
    category: deviation.category,
    description: deviation.description,
    affectedFiles: deviation.affectedFiles,
    initial: record.initial,
  };
  if (record.greybeard !== undefined) {
    details["greybeard"] = record.greybeard;
  }
  return details;
}

function buildDefaultOperatorResolver(
  options: RunKarenLoopForTaskOptions,
): OperatorResolver {
  return async (input) => {
    return awaitOperatorResolution({
      runDir: input.runDir,
      reason: input.reason,
      details: input.details,
      ...(options.operatorPollIntervalMs !== undefined
        ? { pollIntervalMs: options.operatorPollIntervalMs }
        : {}),
      ...(options.operatorTimeoutMs !== undefined
        ? { timeoutMs: options.operatorTimeoutMs }
        : {}),
    });
  };
}
