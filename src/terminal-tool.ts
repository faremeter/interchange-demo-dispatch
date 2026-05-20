// Terminal-tool helper.
//
// `@intx/agent` has no native concept of "the agent halts when this tool is
// called." The runtime is built around `send` -> reactor cycle ->
// `connector.reply` -> `SendResult`; a tool handler returns a `ToolResult`
// and the model continues. To get terminal semantics we expose a tool whose
// handler validates its arguments against an arktype validator, resolves an
// internal Promise on success, and returns a regular `ToolResult`. The
// orchestrator awaits that Promise in parallel with the agent's reactor loop
// and calls `close()` on the agent once the Promise resolves.
//
// Contract:
//
// - On validation success the Promise resolves with the validated value and
//   the handler returns `{ callId, content: "ok" }`. The Promise resolves
//   exactly once; subsequent calls to the same terminal tool return
//   `isError: true` with a "terminal tool already resolved" message so that
//   accidental re-invocation (before the orchestrator has closed the agent)
//   is surfaced to the model rather than silently dropped.
//
// - On validation failure the Promise is NOT resolved and the handler
//   returns `isError: true` carrying the arktype error summary. The model
//   sees the error and can correct its arguments on the next turn.
//
// - The handler is pure validate-and-resolve: no logging, no metrics, no
//   timeouts. Timeouts and lifecycle are the orchestrator's responsibility.

import { tool, type AgentTool } from "@intx/agent";
import { type, type Type } from "arktype";

export interface TerminalTool<T> {
  readonly tool: AgentTool;
  awaitTermination(): Promise<T>;
}

function toInputSchema(schema: Type): Record<string, unknown> {
  return { ...schema.toJsonSchema() };
}

/**
 * Build an `AgentTool` that, when invoked by the model, validates its
 * arguments against `schema` and resolves an awaitable Promise with the
 * validated value. The orchestrator is expected to await the returned
 * `awaitTermination()` Promise in parallel with the agent's reactor loop and
 * close the agent once it resolves.
 *
 * The arktype validator drives both the runtime check inside the handler and
 * (via `schema.toJsonSchema()`) the JSON-schema-shaped `inputSchema` that the
 * inference provider advertises to the model.
 */
export function terminalTool<T>(
  name: string,
  schema: Type<T>,
): TerminalTool<Type<T>["infer"]> {
  type Out = Type<T>["infer"];
  let resolveTermination!: (value: Out) => void;
  const terminationPromise = new Promise<Out>((resolve) => {
    resolveTermination = resolve;
  });

  let resolved = false;

  const agentTool = tool({
    definition: {
      name,
      description: `Terminal tool "${name}". Calling this tool with arguments matching the declared schema signals task completion to the orchestrator.`,
      inputSchema: toInputSchema(schema),
    },
    handler: async (call) => {
      const parsed = schema(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          content: parsed.summary,
          isError: true,
        };
      }
      if (resolved) {
        return {
          callId: call.id,
          content: `terminal tool "${name}" already resolved; the orchestrator should have closed this agent`,
          isError: true,
        };
      }
      resolved = true;
      resolveTermination(parsed);
      return {
        callId: call.id,
        content: "ok",
      };
    },
  });

  return {
    tool: agentTool,
    awaitTermination: () => terminationPromise,
  };
}
