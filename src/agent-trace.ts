// Human-readable agent activity streaming.
//
// Every agent the orchestrator spawns (planner, implementer, critic,
// gate-critic, greybeard, attribution, fix-agent) emits an
// `inference.*` event stream via `agent.stream()`. Each spawn site
// already drains the stream to surface `inference.error` events to
// stderr — without that, a 4xx from the provider silently kills the
// reactor and the orchestrator sees only the terse `AgentClosedError`.
//
// This module extends the same drain to format every interesting event
// (thinking blocks, tool calls, terminal text) into a single line of
// human-readable output, prefixed by which agent emitted it. The
// orchestrator passes the operator-supplied `AgentTrace` callback to
// every spawn site; when present, the formatted lines flow through it.
// When absent, only the error-to-stderr behaviour fires, matching the
// pre-trace contract.
//
// Lines look like:
//
//   [planner] → read_file(path="package.json")
//   [planner] → proposeTask(idHint="install-arktype", level=1, ...)
//   [planner] thinking: I'll start by reading package.json to see what's…
//   [implementer 1a-foo] → write_file(path="src/foo.ts", content=…)
//   [critic 2b-bar round-1] ERROR: Provider returned 429 (rate-limited)
//
// The intent is one line per noteworthy event. Streaming token-by-token
// would drown the operator in deltas; instead the helper accumulates
// thinking / text across `*.delta` events and flushes one summary line
// per turn on `inference.done`.

/* eslint-disable no-console */

/**
 * Operator-facing sink for formatted agent activity lines.
 *
 * Each call receives one fully-formed line WITHOUT a trailing newline;
 * the sink is responsible for adding one when writing to a stream. The
 * canonical production wiring is `(line) => process.stderr.write(line + "\n")`,
 * which keeps stdout reserved for the report path the CLI emits at end.
 *
 * Either a bare function (compact mode — one summary line per turn) or
 * an object carrying a `verbose: true` flag (streaming mode — thinking
 * and terminal-text appear line-by-line as the model emits them).
 */
export type AgentTrace =
  | ((line: string) => void)
  | { write: (line: string) => void; verbose?: boolean };

function resolveTrace(trace: AgentTrace | undefined): {
  write?: (line: string) => void;
  verbose: boolean;
} {
  if (trace === undefined) return { verbose: false };
  if (typeof trace === "function") return { write: trace, verbose: false };
  return { write: trace.write, verbose: trace.verbose ?? false };
}

interface StreamEvent {
  type: string;
  data?: unknown;
}

interface AgentStream {
  stream(): AsyncIterable<StreamEvent>;
}

/**
 * Drain an agent's event stream until the stream ends. Always writes
 * `inference.error` payloads to stderr (the historical contract);
 * additionally, when `trace` is provided, formats every noteworthy event
 * into a single line and calls `trace(line)`.
 *
 * The optional `verbose` flag changes the thinking / text rendering:
 *
 *   - `verbose: false` (default): thinking and text deltas are buffered
 *     across the turn and flushed as a single truncated line on
 *     `inference.done`. Compact; one line per turn.
 *   - `verbose: true`: thinking and text are flushed line-by-line as
 *     they stream, so the operator sees the model's reasoning appear
 *     in near real time. The buffer is flushed on every newline the
 *     model emits, with any trailing partial line held until the next
 *     newline or the turn ends.
 *
 * Returns a Promise that resolves when the stream ends (typically via
 * `agent.close()`). The caller is expected to await it in a `finally`
 * after closing the agent so no events are dropped.
 */
export function drainAgentStream(
  agent: AgentStream,
  label: string,
  trace?: AgentTrace,
): Promise<void> {
  const { write, verbose } = resolveTrace(trace);

  return (async () => {
    let thinkingBuf = "";
    let textBuf = "";

    const flushStreamingByNewlines = (
      bufRef: { value: string },
      prefix: string,
    ) => {
      if (write === undefined) return;
      const lines = bufRef.value.split("\n");
      // Keep the last (possibly-partial) line in the buffer; emit the
      // rest as completed lines. If the buffer ended with a newline,
      // the last element will be the empty string and we still hold it
      // so we don't emit an empty line.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const trimmed = line.replace(/\s+$/, "");
        if (trimmed.length > 0) {
          write(`[${label}] ${prefix} ${trimmed}`);
        }
      }
      bufRef.value = lines[lines.length - 1] ?? "";
    };

    try {
      for await (const event of agent.stream()) {
        // Errors are always loud to stderr, regardless of whether a
        // trace sink is configured.
        if (event.type === "inference.error") {
          const payload = extractErrorPayload(event.data);
          const serialized = safeJSONStringify(payload);
          console.error(`[${label}] inference.error: ${serialized}`);
          if (write !== undefined) {
            write(`[${label}] ERROR: ${oneLine(serialized, 300)}`);
          }
          continue;
        }

        if (write === undefined) continue;

        switch (event.type) {
          case "inference.thinking.delta": {
            const token = extractToken(event.data);
            if (token === null) break;
            thinkingBuf += token;
            if (verbose) {
              const ref = { value: thinkingBuf };
              flushStreamingByNewlines(ref, "🧠");
              thinkingBuf = ref.value;
            }
            break;
          }
          case "inference.text.delta": {
            const token = extractToken(event.data);
            if (token === null) break;
            textBuf += token;
            if (verbose) {
              const ref = { value: textBuf };
              flushStreamingByNewlines(ref, "💬");
              textBuf = ref.value;
            }
            break;
          }
          case "inference.tool_call.end": {
            const formatted = formatToolCallEnd(event.data);
            if (formatted !== null) write(`[${label}] → ${formatted}`);
            break;
          }
          case "inference.done": {
            // Flush whatever survived in the buffers. In verbose mode
            // this is the partial trailing line that hadn't seen a
            // newline yet; in compact mode it's the entire turn.
            if (thinkingBuf.length > 0) {
              const limit = verbose ? 600 : 240;
              const marker = verbose ? "🧠" : "thinking:";
              write(`[${label}] ${marker} ${oneLine(thinkingBuf, limit)}`);
              thinkingBuf = "";
            }
            if (textBuf.length > 0) {
              const limit = verbose ? 600 : 240;
              const marker = verbose ? "💬" : "text:";
              write(`[${label}] ${marker} ${oneLine(textBuf, limit)}`);
              textBuf = "";
            }
            break;
          }
          default:
            break;
        }
      }
    } catch {
      // The stream throws on `agent.close()`. Not a failure mode to
      // surface from the drain itself — the caller already knows the
      // agent closed.
    }
  })();
}

function extractErrorPayload(data: unknown): unknown {
  if (typeof data === "object" && data !== null && "error" in data) {
    return (data as { error: unknown }).error;
  }
  return data;
}

function extractToken(data: unknown): string | null {
  if (typeof data === "object" && data !== null && "token" in data) {
    const token = (data as { token: unknown }).token;
    if (typeof token === "string") return token;
  }
  return null;
}

function formatToolCallEnd(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as {
    name?: unknown;
    arguments?: unknown;
  };
  const name = typeof d.name === "string" ? d.name : "?";
  const args = formatArgs(d.arguments);
  return `${name}(${args})`;
}

function formatArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const parts: string[] = [];
  // `Object.entries` accepts any non-null object and erases the value
  // type to `unknown` per entry — sidesteps the unsafe-narrowing lint
  // and is type-correct since `formatValue` consumes `unknown`.
  for (const [key, value] of Object.entries(args)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  const joined = parts.join(", ");
  return oneLine(joined, 200);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return `"${oneLine(value, 80)}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3) return `[${value.map(formatValue).join(",")}]`;
    return `[${formatValue(value[0])},…+${String(value.length - 1)}]`;
  }
  if (typeof value === "object") {
    try {
      return oneLine(JSON.stringify(value), 60);
    } catch {
      return "{…}";
    }
  }
  return String(value);
}

function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
